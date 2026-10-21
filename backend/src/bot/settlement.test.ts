import assert from "node:assert/strict";
import { test } from "node:test";
import { ccc } from "@ckb-ccc/core";
import DexOrderBot, { type OrderDoc } from "./index.js";

const CKB = 100_000_000n;
const price = 500n * CKB;
const sellCapacity = 200n * CKB;
const buyerLock = ccc.Script.from({ codeHash: `0x${"11".repeat(32)}`, hashType: "type", args: `0x${"22".repeat(20)}` });
const sellerLock = ccc.Script.from({ codeHash: `0x${"33".repeat(32)}`, hashType: "type", args: `0x${"44".repeat(20)}` });
const tokenType = ccc.Script.from({ codeHash: `0x${"55".repeat(32)}`, hashType: "type", args: `0x${"66".repeat(36)}` });
const tokenData = ccc.hexFrom(ccc.numLeToBytes(1_000n, 16));
const minimumTokenCapacity = ccc.CellOutput.from({ lock: buyerLock, type: tokenType }, tokenData).capacity;
const settlementHash = `0x${"99".repeat(32)}`;

function stubBot(buyCapacity: bigint) {
  const buy = {
    _id: "buy", direction: "BID", capacity: buyCapacity.toString(),
    xudtTypeHash: tokenType.hash(), remainingAmount: "1000", pricePerToken: price.toString(),
    ownerLock: buyerLock, outPoint: { txHash: `0x${"77".repeat(32)}`, index: "0" },
  } as unknown as OrderDoc;
  const sell = {
    _id: "sell", direction: "ASK", capacity: sellCapacity.toString(),
    xudtTypeHash: tokenType.hash(), remainingAmount: "1000", pricePerToken: price.toString(),
    ownerLock: sellerLock, typeScript: tokenType, cellData: tokenData,
    outPoint: { txHash: `0x${"88".repeat(32)}`, index: "0" },
  } as unknown as OrderDoc;
  const sent: ccc.Transaction[] = [];
  let reservations = 0;
  // Exercise executeTrade with local chain/DB substitutes; no network or constructor config.
  const bot = Object.create(DexOrderBot.prototype) as DexOrderBot;
  Object.assign(bot, {
    supportedAssetHashes: new Set([tokenType.hash()]),
    dexCellDeps: [{ outPoint: { txHash: `0x${"aa".repeat(32)}`, index: 0 }, depType: "code" }],
    xudtCellDeps: [{ outPoint: { txHash: `0x${"bb".repeat(32)}`, index: 0 }, depType: "code" }],
    reserve: async (id: string) => { reservations++; return id === "buy" ? buy : sell; },
    checkOrderLiveness: async () => true,
    client: { sendTransaction: async (tx: ccc.Transaction) => { sent.push(tx); return settlementHash; } },
    ingestionService: { ingest: async () => ({ status: "APPLIED" }) },
  });
  return { bot, buy, sell, sent, reservationCount: () => reservations };
}

for (const scenario of [
  { name: "large", surplus: 100n * CKB },
  { name: "small", surplus: CKB },
]) {
  test(`bot returns a ${scenario.name} buyer surplus and pays only the sized fee`, async () => {
    const buyCapacity = price + minimumTokenCapacity + scenario.surplus;
    const s = stubBot(buyCapacity);
    assert.equal(await s.bot.executeTrade(s.buy, s.sell), settlementHash);
    assert.equal(s.sent.length, 1);
    const tx = s.sent[0];
    assert.equal(tx.cellDeps.length, 2);
    assert.equal(tx.outputs.length, 2);
    assert.equal(buyCapacity + sellCapacity - tx.getOutputsCapacity(), tx.estimateFee(1_000n));
    assert.equal(tx.outputs[0].capacity, sellCapacity + price);
    assert.equal(tx.outputs[0].lock.hash(), sellerLock.hash());
    assert.equal(tx.outputs[1].lock.hash(), buyerLock.hash());
    assert.equal(tx.outputs[1].type?.hash(), tokenType.hash());
    assert.equal(tx.outputsData[1], tokenData);
    assert.equal(tx.outputs[1].capacity, buyCapacity - price - tx.estimateFee(1_000n));
    assert.ok(tx.outputs[1].capacity > minimumTokenCapacity);
  });
}

test("bot rejects insufficient funding before reserving or submitting orders", async () => {
  const s = stubBot(price + minimumTokenCapacity);
  await assert.rejects(s.bot.executeTrade(s.buy, s.sell), /not carry enough capacity/);
  assert.equal(s.reservationCount(), 0);
  assert.equal(s.sent.length, 0);
});

test("bot rejects an unlisted asset before reserving or submitting orders", async () => {
  const s = stubBot(price + minimumTokenCapacity + CKB);
  Object.assign(s.bot, { supportedAssetHashes: new Set() });
  await assert.rejects(s.bot.executeTrade(s.buy, s.sell), /not listed in the deployment manifest/);
  assert.equal(s.reservationCount(), 0);
  assert.equal(s.sent.length, 0);
});

test("bot rejects an oversized transaction fee before reserving or submitting orders", async () => {
  const s = stubBot(price + minimumTokenCapacity + 100n * CKB);
  Object.assign(s.bot, {
    dexCellDeps: Array.from({ length: 300 }, (_, index) => ({
      outPoint: { txHash: `0x${"aa".repeat(32)}`, index }, depType: "code",
    })),
  });
  await assert.rejects(s.bot.executeTrade(s.buy, s.sell), /exceeds.*contract cap/);
  assert.equal(s.reservationCount(), 0);
  assert.equal(s.sent.length, 0);
});
