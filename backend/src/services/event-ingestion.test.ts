// Verifies ingestion applies projection writes and dedupe records atomically against a real replica set.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";

import { EventIngestionService } from "./event-ingestion.js";
import IngestionEventModel from "../models/ingestion-event.js";
import OrderModel from "../models/order.js";
import type { BotEvent } from "../schemas/bot-events.js";

const hash = (byte: string) => `0x${byte.repeat(32)}`;

const orderConfirmed = (eventId: string, txByte = "33"): BotEvent => ({
  schemaVersion: 1,
  eventId,
  occurredAt: "2026-08-24T12:00:00.000Z",
  transactionHash: hash(txByte),
  blockNumber: "1000",
  blockHash: hash("22"),
  confirmations: 12,
  eventType: "order-confirmed",
  outPoint: { txHash: hash(txByte), index: "0" },
  order: {
    lockScript: { codeHash: hash("44"), hashType: "type", args: "0xabcd" },
    typeScript: { codeHash: hash("55"), hashType: "type", args: "0x" },
    cellData: "0xe8030000000000000000000000000000",
    capacity: "10000000000",
    ownerLock: { codeHash: hash("77"), hashType: "type", args: "0x" },
    ownerLockHash: hash("77"),
    direction: "ASK",
    pricePerToken: "3000000000",
    xudtTypeHash: hash("66"),
    tokenAmount: "1000",
    blockNumber: "999",
    txIndex: "0",
  },
});

let replSet: MongoMemoryReplSet;

before(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replSet.getUri("ckb-dex-ingest"));
  await IngestionEventModel.init();
});

after(async () => {
  await mongoose.disconnect();
  await replSet.stop();
});

test("ingest commits the order projection and the dedupe record together", async () => {
  const service = new EventIngestionService();
  const result = await service.ingest(orderConfirmed("evt-ok"));

  assert.equal(result.status, "APPLIED");
  assert.equal(await OrderModel.countDocuments({ _id: `${hash("33")}:0` }), 1);
  assert.equal(await IngestionEventModel.countDocuments({ eventId: "evt-ok", processingStatus: "APPLIED" }), 1);
});

test("ingest rolls back the projection when the dedupe record cannot be written", async () => {
  const service = new EventIngestionService();
  const originalCreate = IngestionEventModel.create.bind(IngestionEventModel);
  (IngestionEventModel as any).create = async (docs: any, options: any) => {
    if (Array.isArray(docs) && docs[0]?.processingStatus === "APPLIED") {
      throw new Error("injected dedupe write failure");
    }
    return originalCreate(docs, options);
  };

  try {
    await assert.rejects(service.ingest(orderConfirmed("evt-rollback", "88")), /injected/);
  } finally {
    (IngestionEventModel as any).create = originalCreate;
  }

  assert.equal(await OrderModel.countDocuments({ _id: `${hash("88")}:0` }), 0, "projection must roll back");
  const failed = await IngestionEventModel.findOne({ eventId: "evt-rollback" }).lean();
  assert.equal(failed?.processingStatus, "FAILED", "failure stays auditable");
});

test("a failed event can be redelivered and then applies", async () => {
  const service = new EventIngestionService();
  await IngestionEventModel.deleteOne({ eventId: "evt-rollback" });
  const result = await service.ingest(orderConfirmed("evt-rollback", "88"));

  assert.equal(result.status, "APPLIED");
  assert.equal(await OrderModel.countDocuments({ _id: `${hash("88")}:0` }), 1);
});

test("concurrent deliveries of one event apply once", async () => {
  const service = new EventIngestionService();
  const results = await Promise.all([
    service.ingest(orderConfirmed("evt-race", "99")),
    service.ingest(orderConfirmed("evt-race", "99")),
  ]);

  assert.equal(results.filter((result) => result.status === "APPLIED").length, 1);
  assert.equal(await IngestionEventModel.countDocuments({ eventId: "evt-race" }), 1);
});
