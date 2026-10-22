// Verifies the bot's persisted block-hash checkpoints, confirmation depth and reorg detection.
import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

import DexOrderBot from "./index.js";
import ChainCheckpoint from "../models/checkpoint.js";
import type { BotEvent } from "../schemas/bot-events.js";

let mongod: MongoMemoryServer;
before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("bot-checkpoints"));
});
after(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});
beforeEach(() => ChainCheckpoint.deleteMany({}));

const hashes = new Map<number, string>();
const ingested: BotEvent[] = [];
let tip = 1_000n;
let ingestFails = false;
let rangesScanned: Array<[bigint, bigint]> = [];

function makeBot() {
  const bot = Object.create(DexOrderBot.prototype) as DexOrderBot;
  Object.assign(bot, {
    config: { confirmationDepth: 10, dexOrderLockScript: { codeHash: `0x${"11".repeat(32)}`, hashType: "type", args: "0x" } },
    client: {
      getTip: async () => tip,
      getHeaderByNumberNoCache: async (n: bigint | number) => {
        const hash = hashes.get(Number(n));
        return hash ? { hash } : undefined;
      },
      async *findCells(key: { filter: { blockRange: [bigint, bigint] } }) {
        rangesScanned.push(key.filter.blockRange);
      },
    },
    ingestionService: {
      ingest: async (event: BotEvent) => {
        if (ingestFails) throw new Error("backend down");
        ingested.push(event);
        return { status: "APPLIED" };
      },
    },
  });
  return bot;
}

beforeEach(() => {
  hashes.clear();
  ingested.length = 0;
  tip = 1_000n;
  ingestFails = false;
  rangesScanned = [];
});

test("scan stops at tip minus the confirmation depth and persists a checkpoint there", async () => {
  hashes.set(990, "0xaa");
  await makeBot().scanForPendingOrders();
  assert.deepEqual(rangesScanned, [[0n, 991n]]);
  const checkpoint = await ChainCheckpoint.findOne().lean();
  assert.equal(checkpoint?.blockNumber, 990);
  assert.equal(checkpoint?.blockHash, "0xaa");
});

test("the next scan resumes from the persisted checkpoint, and nothing is scanned when no new safe block exists", async () => {
  await ChainCheckpoint.create({ blockNumber: 980, blockHash: "0xold" });
  hashes.set(990, "0xaa");
  const bot = makeBot();
  await bot.scanForPendingOrders();
  assert.deepEqual(rangesScanned, [[981n, 991n]]);

  rangesScanned = [];
  await bot.scanForPendingOrders();
  assert.deepEqual(rangesScanned, []);
});

test("a chain that is shorter than the confirmation depth is not scanned", async () => {
  tip = 5n;
  await makeBot().scanForPendingOrders();
  assert.deepEqual(rangesScanned, []);
  assert.equal(await ChainCheckpoint.countDocuments(), 0);
});

test("a hash change while scanning leaves the cursor untouched so the range is rescanned", async () => {
  hashes.set(990, "0xaa");
  const bot = makeBot();
  let calls = 0;
  (bot as any).client.getHeaderByNumberNoCache = async () => ({ hash: calls++ === 0 ? "0xaa" : "0xbb" });
  await bot.scanForPendingOrders();
  assert.equal(await ChainCheckpoint.countDocuments(), 0);
});

test("detectReorg does nothing while the newest checkpoint is canonical", async () => {
  await ChainCheckpoint.create([{ blockNumber: 100, blockHash: "0x100" }, { blockNumber: 90, blockHash: "0x90" }]);
  hashes.set(100, "0x100");
  await makeBot().detectReorg();
  assert.equal(ingested.length, 0);
  assert.equal(await ChainCheckpoint.countDocuments(), 2);
});

test("detectReorg reports the fork point, then rewinds the cursor to the last common block", async () => {
  await ChainCheckpoint.create([
    { blockNumber: 100, blockHash: "0x100" },
    { blockNumber: 90, blockHash: "0x90" },
    { blockNumber: 80, blockHash: "0x80" },
  ]);
  hashes.set(100, "0xnew100");
  hashes.set(90, "0x90");

  await makeBot().detectReorg();

  assert.equal(ingested.length, 1);
  const event = ingested[0];
  assert.equal(event.eventType, "chain-reorg");
  if (event.eventType === "chain-reorg") {
    assert.equal(event.revertedBlockNumber, "100");
    assert.equal(event.revertedBlockHash, "0x100");
    assert.equal(event.ancestorBlockNumber, "90");
  }
  assert.deepEqual((await ChainCheckpoint.find().sort({ blockNumber: 1 }).lean()).map((c) => c.blockNumber), [80, 90]);
});

test("detectReorg keeps the checkpoints when the backend rejects the rollback, so it retries", async () => {
  await ChainCheckpoint.create([{ blockNumber: 100, blockHash: "0x100" }, { blockNumber: 90, blockHash: "0x90" }]);
  hashes.set(100, "0xnew");
  hashes.set(90, "0x90");
  ingestFails = true;
  await assert.rejects(makeBot().detectReorg(), /backend down/);
  assert.equal(await ChainCheckpoint.countDocuments(), 2);
});

test("a reorg deeper than the checkpoint window rolls back from the oldest checkpoint", async () => {
  await ChainCheckpoint.create([{ blockNumber: 100, blockHash: "0x100" }, { blockNumber: 90, blockHash: "0x90" }]);
  hashes.set(100, "0xn1");
  hashes.set(90, "0xn2");
  await makeBot().detectReorg();
  const event = ingested[0];
  assert.equal(event.eventType === "chain-reorg" && event.ancestorBlockNumber, "89");
  assert.equal(await ChainCheckpoint.countDocuments(), 0);
});
