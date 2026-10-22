// Verifies ingestion is chain-verified, atomic, and reorg-safe against a real replica set and a fake chain.
import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { ccc } from "@ckb-ccc/core";

import { EventIngestionService } from "./event-ingestion.js";
import {
  registerChainVerification,
  type ChainReader,
  type ChainTransaction,
} from "./chain-verifier.js";
import IngestionEventModel from "../models/ingestion-event.js";
import OrderModel from "../models/order.js";
import TradeModel from "../models/trade.js";
import type { BotEvent } from "../schemas/bot-events.js";
import type { Hex } from "../types/index.js";

const hash = (byte: string) => `0x${byte.repeat(32)}` as Hex;
const DEPTH = 10;

const dexLock = { codeHash: hash("44"), hashType: "type" as const };
const ownerLock = { codeHash: hash("77"), hashType: "type" as const, args: "0x" as Hex };
const buyerLock = { codeHash: hash("78"), hashType: "type" as const, args: "0x" as Hex };
const xudtType = { codeHash: hash("55"), hashType: "type" as const, args: "0x" as Hex };
const lockHash = (script: typeof ownerLock) => ccc.Script.from(script).hash() as Hex;
const xudtHash = lockHash(xudtType);

function orderArgs(side: 0 | 1, maker: Hex, amount: bigint, price: bigint): Hex {
  const bytes = new Uint8Array(90);
  bytes[0] = 1;
  bytes[1] = side;
  bytes.set(ccc.bytesFrom(maker), 2);
  bytes.set(ccc.bytesFrom(xudtHash), 34);
  bytes.set(ccc.numLeToBytes(amount, 16), 66);
  bytes.set(ccc.numLeToBytes(price, 8), 82);
  return ccc.hexFrom(bytes) as Hex;
}

class FakeChain implements ChainReader {
  tip = 1_000n;
  txs = new Map<string, ChainTransaction>();
  canonical = new Map<bigint, Hex>();
  async getTip() { return this.tip; }
  async getTransaction(txHash: Hex) { return this.txs.get(txHash); }
  async getCanonicalBlockHash(blockNumber: bigint) { return this.canonical.get(blockNumber); }
}

const chain = new FakeChain();
const sellOutPoint = { txHash: hash("a1"), index: "0" };
const buyOutPoint = { txHash: hash("a2"), index: "0" };
const settleTx = hash("c1");
const AMOUNT = 1000n;
const PRICE = 3_000_000_000n;

function putOrderTx(op: { txHash: Hex }, side: 0 | 1, maker: typeof ownerLock, block = 900n, blockHash = hash("b1"), funder?: Hex) {
  const makerHash = lockHash(maker);
  chain.txs.set(op.txHash, {
    status: "committed",
    blockNumber: block,
    blockHash,
    txIndex: 0n,
    inputs: [],
    inputLockHashes: [funder ?? makerHash],
    outputs: [{
      lock: { ...dexLock, args: orderArgs(side, makerHash, AMOUNT, PRICE) },
      type: side === 1 ? xudtType : undefined,
      capacity: 10_000_000_000n,
      data: side === 1 ? (ccc.hexFrom(ccc.numLeToBytes(AMOUNT, 16)) as Hex) : "0x",
    }],
  });
}

function orderEvent(op: { txHash: Hex; index: string }, side: 0 | 1, maker: typeof ownerLock, eventId: string, block = "900", blockHash = hash("b1")): BotEvent {
  const makerHash = lockHash(maker);
  return {
    schemaVersion: 1,
    eventId,
    occurredAt: "2026-08-24T12:00:00.000Z",
    transactionHash: op.txHash,
    blockNumber: block,
    blockHash,
    eventType: "order-confirmed",
    outPoint: op,
    order: {
      lockScript: { ...dexLock, args: orderArgs(side, makerHash, AMOUNT, PRICE) },
      typeScript: side === 1 ? xudtType : undefined,
      cellData: side === 1 ? (ccc.hexFrom(ccc.numLeToBytes(AMOUNT, 16)) as Hex) : "0x",
      capacity: "10000000000",
      ownerLock: maker,
      ownerLockHash: makerHash,
      direction: side === 1 ? "ASK" : "BID",
      pricePerToken: PRICE.toString(),
      tokenAmount: AMOUNT.toString(),
      xudtTypeHash: xudtHash,
      blockNumber: block,
      txIndex: "0",
    },
  };
}

function tradeEvent(eventId: string, block = "950", blockHash = hash("b2")): BotEvent {
  return {
    schemaVersion: 1,
    eventId,
    occurredAt: "2026-08-24T12:00:00.000Z",
    transactionHash: settleTx,
    blockNumber: block,
    blockHash,
    eventType: "trade-confirmed",
    buyOrderOutPoint: buyOutPoint,
    sellOrderOutPoint: sellOutPoint,
    trade: {
      settlementTxHash: settleTx,
      buyerLockHash: lockHash(buyerLock),
      sellerLockHash: lockHash(ownerLock),
      xudtTypeHash: xudtHash,
      tokenAmount: AMOUNT.toString(),
      price: PRICE.toString(),
      paidCapacity: PRICE.toString(),
      confirmedAtBlock: block,
    },
  };
}

function putSettlement(block = 950n, blockHash = hash("b2")) {
  chain.txs.set(settleTx, {
    status: "committed",
    blockNumber: block,
    blockHash,
    txIndex: 1n,
    inputs: [buyOutPoint, sellOutPoint],
    inputLockHashes: [],
    outputs: [],
  });
}

const orderId = (op: { txHash: string; index: string }) => `${op.txHash}:${op.index}`;
let replSet: MongoMemoryReplSet;
const service = new EventIngestionService();

before(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replSet.getUri("ckb-dex-ingest"));
  await Promise.all([IngestionEventModel.init(), OrderModel.init(), TradeModel.init()]);
});

after(async () => {
  registerChainVerification(undefined);
  await mongoose.disconnect();
  await replSet.stop();
});

beforeEach(async () => {
  await Promise.all([IngestionEventModel.deleteMany({}), OrderModel.deleteMany({}), TradeModel.deleteMany({})]);
  chain.tip = 1_000n;
  chain.txs.clear();
  chain.canonical.clear();
  registerChainVerification({
    chain,
    dexLock: { ...dexLock, args: "0x" },
    confirmationDepth: DEPTH,
    supportedAssetHashes: new Set([xudtHash]),
  });
});

async function seedPair() {
  putOrderTx(sellOutPoint, 1, ownerLock);
  putOrderTx(buyOutPoint, 0, buyerLock, 900n, hash("b1"));
  await service.ingest(orderEvent(sellOutPoint, 1, ownerLock, "sell-created"));
  await service.ingest(orderEvent(buyOutPoint, 0, buyerLock, "buy-created"));
}

test("ingestion fails closed when no chain verification is registered", async () => {
  registerChainVerification(undefined);
  await assert.rejects(service.ingest(orderEvent(sellOutPoint, 1, ownerLock, "e1")), /not configured/);
  assert.equal(await OrderModel.countDocuments(), 0);
});

test("order-confirmed matching the chain is applied and stores the creating block hash", async () => {
  putOrderTx(sellOutPoint, 1, ownerLock);
  const result = await service.ingest(orderEvent(sellOutPoint, 1, ownerLock, "ok"));
  assert.equal(result.status, "APPLIED");
  const order = await OrderModel.findById(orderId(sellOutPoint)).lean();
  assert.equal(order?.status, "LIVE");
  assert.equal(order?.createdBlockHash, hash("b1"));
});

test("order-confirmed is rejected when the chain disagrees, and the failure is audited", async () => {
  const cases: Array<[string, () => BotEvent]> = [
    ["unknown transaction", () => orderEvent({ txHash: hash("ee"), index: "0" }, 1, ownerLock, "bad-1")],
    ["wrong block hash", () => { putOrderTx(sellOutPoint, 1, ownerLock); return orderEvent(sellOutPoint, 1, ownerLock, "bad-2", "900", hash("fe")); }],
    ["maker did not fund", () => { putOrderTx(sellOutPoint, 1, ownerLock, 900n, hash("b1"), hash("99")); return orderEvent(sellOutPoint, 1, ownerLock, "bad-3"); }],
    ["forged price", () => {
      putOrderTx(sellOutPoint, 1, ownerLock);
      const event = orderEvent(sellOutPoint, 1, ownerLock, "bad-4");
      if (event.eventType === "order-confirmed") event.order.pricePerToken = "1";
      return event;
    }],
    ["forged maker", () => {
      putOrderTx(sellOutPoint, 1, ownerLock);
      const event = orderEvent(sellOutPoint, 1, ownerLock, "bad-5");
      if (event.eventType === "order-confirmed") event.order.ownerLock = buyerLock;
      return event;
    }],
  ];

  for (const [label, build] of cases) {
    chain.txs.clear();
    const event = build();
    await assert.rejects(service.ingest(event), (error: any) => error.statusCode === 422, label);
    assert.equal(await OrderModel.countDocuments(), 0, label);
    assert.equal(await IngestionEventModel.countDocuments({ eventId: event.eventId, processingStatus: "FAILED" }), 1, label);
  }
});

test("an event that is not buried deep enough is refused without audit noise and applies later", async () => {
  putOrderTx(sellOutPoint, 1, ownerLock, 995n);
  const event = orderEvent(sellOutPoint, 1, ownerLock, "shallow", "995");
  await assert.rejects(service.ingest(event), (error: any) => error.statusCode === 409);
  assert.equal(await IngestionEventModel.countDocuments(), 0);
  assert.equal(await OrderModel.countDocuments(), 0);

  chain.tip = 1_005n;
  assert.equal((await service.ingest(event)).status, "APPLIED");
});

test("a rejected event can be redelivered with the same id once the chain agrees", async () => {
  const event = orderEvent(sellOutPoint, 1, ownerLock, "retry");
  await assert.rejects(service.ingest(event), (error: any) => error.statusCode === 422);
  putOrderTx(sellOutPoint, 1, ownerLock);
  assert.equal((await service.ingest(event)).status, "APPLIED");
  assert.equal(await IngestionEventModel.countDocuments({ eventId: "retry", processingStatus: "APPLIED" }), 1);
  assert.equal(await IngestionEventModel.countDocuments({ eventId: "retry", processingStatus: "FAILED" }), 0);
});

test("ingest rolls back the projection when the dedupe record cannot be written", async () => {
  putOrderTx(sellOutPoint, 1, ownerLock);
  const originalCreate = IngestionEventModel.create.bind(IngestionEventModel);
  (IngestionEventModel as any).create = async (docs: any, options: any) => {
    if (Array.isArray(docs) && docs[0]?.processingStatus === "APPLIED") throw new Error("injected dedupe write failure");
    return originalCreate(docs, options);
  };

  try {
    await assert.rejects(service.ingest(orderEvent(sellOutPoint, 1, ownerLock, "rollback")), /injected/);
  } finally {
    (IngestionEventModel as any).create = originalCreate;
  }

  assert.equal(await OrderModel.countDocuments(), 0, "projection must roll back");
  assert.equal((await IngestionEventModel.findOne({ eventId: "rollback" }).lean())?.processingStatus, "FAILED");
  assert.equal((await service.ingest(orderEvent(sellOutPoint, 1, ownerLock, "rollback"))).status, "APPLIED");
});

test("concurrent deliveries of one event apply once", async () => {
  putOrderTx(sellOutPoint, 1, ownerLock);
  const results = await Promise.all([
    service.ingest(orderEvent(sellOutPoint, 1, ownerLock, "race")),
    service.ingest(orderEvent(sellOutPoint, 1, ownerLock, "race")),
  ]);
  assert.equal(results.filter((result) => result.status === "APPLIED").length, 1);
  assert.equal(await IngestionEventModel.countDocuments({ eventId: "race" }), 1);
});

test("cancellation must be authorized by the maker and spend the order", async () => {
  await seedPair();
  const cancelTx = hash("c2");
  const cancel: BotEvent = {
    schemaVersion: 1, eventId: "cancel", occurredAt: "2026-08-24T12:00:00.000Z",
    transactionHash: cancelTx, blockNumber: "940", blockHash: hash("b3"),
    eventType: "order-cancelled", outPoint: sellOutPoint, cancelledByTxHash: cancelTx,
  };

  chain.txs.set(cancelTx, { status: "committed", blockNumber: 940n, blockHash: hash("b3"), inputs: [sellOutPoint], inputLockHashes: [hash("99")], outputs: [] });
  await assert.rejects(service.ingest(cancel), (error: any) => error.statusCode === 422);
  assert.equal((await OrderModel.findById(orderId(sellOutPoint)).lean())?.status, "LIVE");

  chain.txs.set(cancelTx, { status: "committed", blockNumber: 940n, blockHash: hash("b3"), inputs: [sellOutPoint], inputLockHashes: [lockHash(ownerLock)], outputs: [] });
  assert.equal((await service.ingest(cancel)).status, "APPLIED");
  assert.equal((await OrderModel.findById(orderId(sellOutPoint)).lean())?.status, "CANCELED");
});

test("trade-confirmed requires a settlement that spends both orders and matching trade fields", async () => {
  await seedPair();
  putSettlement();
  chain.txs.set(settleTx, { ...chain.txs.get(settleTx)!, inputs: [sellOutPoint] });
  await assert.rejects(service.ingest(tradeEvent("t-bad")), (error: any) => error.statusCode === 422);

  putSettlement();
  const forged = tradeEvent("t-forged");
  if (forged.eventType === "trade-confirmed") forged.trade.price = "1";
  await assert.rejects(service.ingest(forged), (error: any) => error.statusCode === 422);
  assert.equal(await TradeModel.countDocuments(), 0);

  assert.equal((await service.ingest(tradeEvent("t-ok"))).status, "APPLIED");
  assert.equal((await OrderModel.findById(orderId(sellOutPoint)).lean())?.status, "FILLED");
  assert.equal((await TradeModel.findById(settleTx).lean())?.status, "CONFIRMED");
});

const reorgEvent = (id: string, number: string, oldHash: Hex, ancestor?: string): BotEvent => ({
  schemaVersion: 1, eventId: id, occurredAt: "2026-08-24T12:00:00.000Z",
  eventType: "chain-reorg", revertedBlockNumber: number, revertedBlockHash: oldHash, ancestorBlockNumber: ancestor,
});

test("a reorg is only accepted when the claimed block is no longer canonical", async () => {
  await seedPair();
  chain.canonical.set(900n, hash("b1"));
  await assert.rejects(service.ingest(reorgEvent("r-bad", "900", hash("b1"))), (error: any) => error.statusCode === 422);
  assert.equal((await OrderModel.findById(orderId(sellOutPoint)).lean())?.status, "LIVE");
});

test("a reorg orphans reverted creations, reopens reverted fills, and reverts trades; re-inclusion restores them", async () => {
  await seedPair();
  putSettlement();
  await service.ingest(tradeEvent("t-ok"));
  assert.equal((await OrderModel.findById(orderId(buyOutPoint)).lean())?.status, "FILLED");

  // Blocks >= 950 are replaced: the settlement is reverted, the order creations (900) survive.
  chain.canonical.set(950n, hash("f0"));
  await service.ingest(reorgEvent("r1", "950", hash("b2"), "949"));

  const sell = await OrderModel.findById(orderId(sellOutPoint)).lean();
  assert.equal(sell?.status, "LIVE");
  assert.equal(sell?.spentAtBlock, undefined);
  assert.equal(sell?.settlementTxHash, undefined);
  assert.equal((await TradeModel.findById(settleTx).lean())?.status, "REVERTED");

  // The settlement is re-included in a different block: it confirms again under a new event id.
  putSettlement(951n, hash("f1"));
  assert.equal((await service.ingest(tradeEvent("t-again", "951", hash("f1")))).status, "APPLIED");
  const trade = await TradeModel.findById(settleTx).lean();
  assert.equal(trade?.status, "CONFIRMED");
  assert.equal(trade?.blockHash, hash("f1"));
  assert.equal((await OrderModel.findById(orderId(buyOutPoint)).lean())?.status, "FILLED");
  assert.equal(await TradeModel.countDocuments(), 1);

  // A deeper reorg removes the order creations themselves.
  chain.canonical.set(900n, hash("e0"));
  await service.ingest(reorgEvent("r2", "900", hash("b1"), "899"));
  assert.equal((await OrderModel.findById(orderId(sellOutPoint)).lean())?.status, "ORPHANED");
  assert.equal((await TradeModel.findById(settleTx).lean())?.status, "REVERTED");

  // The creating transaction is re-mined in another block and re-indexed.
  putOrderTx(sellOutPoint, 1, ownerLock, 902n, hash("e1"));
  assert.equal((await service.ingest(orderEvent(sellOutPoint, 1, ownerLock, "sell-again", "902", hash("e1")))).status, "APPLIED");
  const revived = await OrderModel.findById(orderId(sellOutPoint)).lean();
  assert.equal(revived?.status, "LIVE");
  assert.equal(revived?.createdBlockHash, hash("e1"));
  assert.equal(revived?.spentAtBlock, undefined);
});

test("redelivering order-confirmed for an indexed order does not reset it", async () => {
  putOrderTx(sellOutPoint, 1, ownerLock);
  await service.ingest(orderEvent(sellOutPoint, 1, ownerLock, "first"));
  await OrderModel.updateOne({ _id: orderId(sellOutPoint) }, { $set: { status: "RESERVED" } });
  const again = await service.ingest(orderEvent(sellOutPoint, 1, ownerLock, "second"));
  assert.equal(again.reason, "order-already-indexed");
  assert.equal((await OrderModel.findById(orderId(sellOutPoint)).lean())?.status, "RESERVED");
});
