// Verifies pair selection, failure isolation, competing-submission handling and in-flight reconciliation.
import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { ccc } from "@ckb-ccc/core";

import DexOrderBot, { type OrderDoc } from "./index.js";
import { MatchHealth } from "./match-health.js";
import OrderModel from "../models/order.js";
import AppError from "../services/error.js";

let mongod: MongoMemoryServer;
before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("bot-matching"));
});
after(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});
beforeEach(() => OrderModel.deleteMany({}));

const CKB = 100_000_000n;
const price = 500n * CKB;
const buyerLock = ccc.Script.from({ codeHash: `0x${"11".repeat(32)}`, hashType: "type", args: `0x${"22".repeat(20)}` });
const sellerLock = ccc.Script.from({ codeHash: `0x${"33".repeat(32)}`, hashType: "type", args: `0x${"44".repeat(20)}` });
const tokenType = ccc.Script.from({ codeHash: `0x${"55".repeat(32)}`, hashType: "type", args: `0x${"66".repeat(36)}` });
const tokenData = ccc.hexFrom(ccc.numLeToBytes(1_000n, 16));
const settlementHash = `0x${"99".repeat(32)}`;
const minimumTokenCapacity = ccc.CellOutput.from({ lock: buyerLock, type: tokenType }, tokenData).capacity;

let seq = 0;
function order(direction: "ASK" | "BID", extra: Record<string, unknown> = {}): OrderDoc {
  seq += 1;
  const id = `${direction}-${seq}`;
  return {
    _id: id,
    direction,
    capacity: (direction === "BID" ? price + minimumTokenCapacity + 100n * CKB : 200n * CKB).toString(),
    xudtTypeHash: tokenType.hash(),
    remainingAmount: "1000",
    pricePerToken: price.toString(),
    ownerLock: direction === "BID" ? buyerLock : sellerLock,
    typeScript: tokenType,
    cellData: tokenData,
    blockNumber: String(seq),
    txIndex: "0",
    outPoint: { txHash: `0x${seq.toString(16).padStart(64, "0")}`, index: "0" },
    ...extra,
  } as unknown as OrderDoc;
}

function bareBot(overrides: Record<string, unknown> = {}) {
  const bot = Object.create(DexOrderBot.prototype) as DexOrderBot;
  Object.assign(bot, overrides);
  return bot;
}

const ids = (pairs: Array<{ buy: OrderDoc; sell: OrderDoc }>) => pairs.map(({ buy, sell }) => `${buy._id}/${sell._id}`);

test("findMatches pairs every disjoint exact match, oldest first", () => {
  const [b1, b2, s1, s2] = [order("BID"), order("BID"), order("ASK"), order("ASK")];
  assert.deepEqual(ids(bareBot().findMatches([b2, s2, b1, s1])), [`${b1._id}/${s1._id}`, `${b2._id}/${s2._id}`]);
});

test("a blocked pair does not hide alternative pairings of the same orders", () => {
  const [b1, b2, s1, s2] = [order("BID"), order("BID"), order("ASK"), order("ASK")];
  const bot = bareBot();
  (bot as any).health.recordPairFailure(b1._id, s1._id);
  assert.deepEqual(ids(bot.findMatches([b1, b2, s1, s2])), [`${b1._id}/${s2._id}`, `${b2._id}/${s1._id}`]);
});

test("a quarantined order is skipped while the rest of the book still matches", () => {
  const [b1, b2, s1] = [order("BID"), order("BID"), order("ASK")];
  const bot = bareBot();
  (bot as any).health.quarantineOrder(b1._id);
  assert.deepEqual(ids(bot.findMatches([b1, b2, s1])), [`${b2._id}/${s1._id}`]);
});

test("MatchHealth backs off exponentially and expires", () => {
  const health = new MatchHealth();
  assert.equal(health.recordPairFailure("b", "s", 0), 5_000);
  assert.equal(health.recordPairFailure("b", "s", 0), 10_000);
  assert.equal(health.isPairBlocked("b", "s", 9_999), true);
  assert.equal(health.isPairBlocked("b", "s", 10_000), false);
  health.recordSuccess("b", "s");
  assert.equal(health.recordPairFailure("b", "s", 0), 5_000);
  health.quarantineOrder("x", 1_000, 0);
  assert.equal(health.isOrderQuarantined("x", 999), true);
  assert.equal(health.isOrderQuarantined("x", 1_000), false);
});

test("an unsettleable pair does not stop the other matches in the same tick or the next", async () => {
  const [badBuy, goodBuy, sellOne, sellTwo] = [order("BID"), order("BID"), order("ASK"), order("ASK")];
  const attempted: string[] = [];
  const bot = bareBot({
    _pendingPairOrders: [badBuy, goodBuy, sellOne, sellTwo],
    executeTrade: async (buy: OrderDoc, sell: OrderDoc) => {
      attempted.push(`${buy._id}/${sell._id}`);
      if (buy._id === badBuy._id) throw new AppError(409, "not enough capacity", "INSUFFICIENT_BUY_CAPACITY");
      return settlementHash;
    },
  });

  await (bot as any).matchPendingOrders();
  assert.deepEqual(attempted, [`${badBuy._id}/${sellOne._id}`, `${goodBuy._id}/${sellTwo._id}`]);

  attempted.length = 0;
  await (bot as any).matchPendingOrders();
  assert.ok(attempted.every((pair) => !pair.startsWith(badBuy._id as string)), "quarantined buy is not retried");
});

test("a transient failure backs the pair off instead of retrying it every tick", async () => {
  const [buy, sell] = [order("BID"), order("ASK")];
  let calls = 0;
  const bot = bareBot({
    _pendingPairOrders: [buy, sell],
    executeTrade: async () => { calls++; throw new Error("rpc timeout"); },
  });
  await (bot as any).matchPendingOrders();
  await (bot as any).matchPendingOrders();
  assert.equal(calls, 1);
});

for (const [message, code] of [
  ["PoolRejectedDuplicatedTransaction: already in pool", undefined],
  ["TransactionFailedToResolve: Resolve(Dead(OutPoint(0xabc)))", "ORDER_SPENT"],
  ["PoolRejectedRBF: conflicts with a pending transaction", "COMPETING_SETTLEMENT"],
] as const) {
  test(`submit classifies node rejection: ${message.split(":")[0]}`, async () => {
    const tx = ccc.Transaction.from({ outputs: [{ lock: buyerLock }], outputsData: ["0x"] });
    const bot = bareBot({ client: { sendTransaction: async () => { throw new Error(message); } } });
    if (code === undefined) {
      assert.equal(await (bot as any).submit(tx), tx.hash(), "an identical pending tx is adopted");
    } else {
      await assert.rejects((bot as any).submit(tx), (error: AppError) => error.code === code);
    }
  });
}

function settlementBot(sendOutcome: () => Promise<string>, ingest: () => Promise<unknown>) {
  const buy = order("BID");
  const sell = order("ASK");
  const reverted: string[] = [];
  const bot = bareBot({
    supportedAssetHashes: new Set([tokenType.hash()]),
    dexCellDeps: [{ outPoint: { txHash: `0x${"aa".repeat(32)}`, index: 0 }, depType: "code" }],
    xudtCellDeps: [{ outPoint: { txHash: `0x${"bb".repeat(32)}`, index: 0 }, depType: "code" }],
    reserve: async (id: string) => (id === buy._id ? buy : sell),
    checkOrderLiveness: async () => true,
    revertToLive: async (id: string) => { reverted.push(id); },
    client: { sendTransaction: sendOutcome },
    ingestionService: { ingest },
  });
  return { bot, buy, sell, reverted };
}

test("a cell spent by a competitor releases the orders and surfaces ORDER_SPENT", async () => {
  const s = settlementBot(async () => { throw new Error("Resolve(Dead(OutPoint))"); }, async () => ({}));
  await assert.rejects(s.bot.executeTrade(s.buy, s.sell), (error: AppError) => error.code === "ORDER_SPENT");
  assert.deepEqual(s.reverted.sort(), [s.buy._id, s.sell._id].sort());
});

test("a settlement already in the pool is tracked as pending, not released, when recording it fails", async () => {
  const buy = await OrderModel.create(seedDoc("BID"));
  const sell = await OrderModel.create(seedDoc("ASK"));
  const s = settlementBot(async () => settlementHash, async () => { throw new Error("backend unavailable"); });
  const buyDoc = order("BID", { _id: buy._id, capacity: (price + minimumTokenCapacity + 100n * CKB).toString() });
  const sellDoc = order("ASK", { _id: sell._id });
  Object.assign(s.bot, { reserve: async (id: string) => (id === buy._id ? buyDoc : sellDoc) });

  assert.equal(await s.bot.executeTrade(buyDoc, sellDoc), settlementHash);
  assert.deepEqual(s.reverted, [], "orders stay claimed by the in-flight tx");
  for (const id of [buy._id, sell._id]) {
    const saved = await OrderModel.findById(id).lean();
    assert.equal(saved?.status, "PENDING");
    assert.equal(saved?.pendingTxHash, settlementHash);
  }
});

function seedDoc(direction: "ASK" | "BID", extra: Record<string, unknown> = {}): any {
  seq += 1;
  const script = { codeHash: `0x${"11".repeat(32)}`, hashType: "type", args: "0x" };
  return {
    _id: `seed-${seq}`,
    outPoint: { txHash: `0x${seq.toString(16).padStart(64, "0")}`, index: "0" },
    lockScript: script, cellData: "0x", capacity: "1", ownerLock: script, ownerLockHash: `0x${"22".repeat(32)}`,
    direction, pricePerToken: "1", remainingAmount: "1", tokenPair: "x:CKB", xudtTypeHash: `0x${"33".repeat(32)}`,
    blockNumber: "1", txIndex: "0", status: "PENDING", pendingTxHash: settlementHash,
    reservedUntil: new Date(Date.now() - 1_000),
    ...extra,
  };
}

test("retryFailSwaps releases rejected settlements at once, but reconciles competitor-spent orders instead", async () => {
  const rejected = await OrderModel.create(seedDoc("BID", { pendingTxHash: `0x${"d1".repeat(32)}`, reservedUntil: new Date(Date.now() + 60_000) }));
  const spent = await OrderModel.create(seedDoc("ASK", { pendingTxHash: `0x${"d2".repeat(32)}`, reservedUntil: new Date(Date.now() + 60_000) }));
  const bot = bareBot({
    client: { getTransaction: async () => ({ status: "rejected" }) },
    checkOrderLiveness: async (o: OrderDoc) => o._id === (rejected._id as string),
  });

  await bot.retryFailSwaps();

  assert.equal((await OrderModel.findById(rejected._id).lean())?.status, "LIVE");
  assert.equal((await OrderModel.findById(spent._id).lean())?.status, "PENDING", "left to the spend reconciliation");
});

test("retryFailSwaps keeps an unknown settlement until its reservation expires", async () => {
  const fresh = await OrderModel.create(seedDoc("BID", { reservedUntil: new Date(Date.now() + 60_000) }));
  const stale = await OrderModel.create(seedDoc("ASK"));
  const bot = bareBot({
    client: { getTransaction: async () => undefined },
    checkOrderLiveness: async () => true,
  });

  await bot.retryFailSwaps();

  assert.equal((await OrderModel.findById(fresh._id).lean())?.status, "PENDING");
  assert.equal((await OrderModel.findById(stale._id).lean())?.status, "LIVE");
});

test("a confirmed settlement whose counterpart leg is gone is released once its reservation expires", async () => {
  const lone = await OrderModel.create(seedDoc("BID"));
  const bot = bareBot({
    client: { getTransaction: async () => ({ status: "committed", blockNumber: 5n, blockHash: "0x1", transaction: {} }) },
  });
  await bot.retryFailSwaps();
  assert.equal((await OrderModel.findById(lone._id).lean())?.status, "LIVE");
});
