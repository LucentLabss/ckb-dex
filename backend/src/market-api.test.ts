// Verifies the market read endpoints against a real temporary MongoDB instance.
import test from "node:test";
import assert from "node:assert/strict";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";

import { createExpressServer } from "./app.js";
import OrderModel from "./models/order.js";
import TradeModel from "./models/trade.js";
import type { Config } from "./types";

const config: Config = {
  mongodbUrl: "mongodb://127.0.0.1:27017/ckb-dex",
  ckbRpcUrl: "http://127.0.0.1:8114",
  enviroment: "development",
  dexOrderLockScript: {
    codeHash: `0x${"11".repeat(32)}` as `0x${string}`,
    hashType: "type",
    args: "0x",
  },
  internalBotToken: "test-bot-token",
  port: 3100,
  apiVersion: 1,
};

test("market read APIs return DB-backed snapshots", async () => {
  const mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("ckb-dex"));

  try {
    await OrderModel.create({
      _id: "0xaaa:0",
      outPoint: { txHash: "0xaaa", index: "0" },
      lockScript: {
        codeHash: "0x1111111111111111111111111111111111111111111111111111111111111111",
        hashType: "type",
        args: "0x1234",
      },
      typeScript: {
        codeHash: "0x2222222222222222222222222222222222222222222222222222222222222222",
        hashType: "type",
        args: "0x",
      },
      cellData: "0xe8030000000000000000000000000000",
      capacity: "5000",
      ownerLock: {
        codeHash: "0x4444444444444444444444444444444444444444444444444444444444444444",
        hashType: "type",
        args: "0x",
      },
      ownerLockHash: "0x4444444444444444444444444444444444444444444444444444444444444444",
      direction: "ASK",
      pricePerToken: "2500",
      remainingAmount: "1000",
      tokenPair: "0x3333333333333333333333333333333333333333333333333333333333333333:CKB",
      blockNumber: "42",
      txIndex: "0",
      orderCellLockHash: "0x1111111111111111111111111111111111111111111111111111111111111111",
      dexLockArgs: "0x1234",
      typeScriptHash: "0x2222222222222222222222222222222222222222222222222222222222222222",
      xudtTypeHash: "0x3333333333333333333333333333333333333333333333333333333333333333",
      makerLockHash: "0x4444444444444444444444444444444444444444444444444444444444444444",
      makerAddress: "ckt1example",
      side: "SELL",
      tokenAmount: "1000",
      orderCapacity: "5000",
      totalAskCapacity: "2500",
      status: "LIVE",
      createdAtTxHash: "0x5555555555555555555555555555555555555555555555555555555555555555",
      lastEventId: "event-1",
    });

    await TradeModel.create({
      _id: "0xsettle:0xaaa:0",
      settlementTxHash: "0xsettle",
      buyOrderOutPoint: { txHash: "0xbbb", index: "1" },
      sellOrderOutPoint: { txHash: "0xaaa", index: "0" },
      buyerLockHash: "0x6666666666666666666666666666666666666666666666666666666666666666",
      sellerLockHash: "0x4444444444444444444444444444444444444444444444444444444444444444",
      xudtTypeHash: "0x3333333333333333333333333333333333333333333333333333333333333333",
      tokenAmount: "1000",
      price: "2500",
      paidCapacity: "2600",
      blockNumber: "42",
      blockHash: "0x7777777777777777777777777777777777777777777777777777777777777777",
      confirmedAtBlock: "42",
      lastEventId: "trade-event-1",
    });

    const app = createExpressServer(config, { isReady: () => true });
    const server = app.listen(0);
    const address = server.address();
    assert.ok(address && typeof address === "object" && "port" in address);

    try {
      const marketsResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/markets`);
      assert.equal(marketsResponse.status, 200);
      const marketsBody = await marketsResponse.json();
      assert.deepEqual(marketsBody.data.markets, ["0x3333333333333333333333333333333333333333333333333333333333333333"]);

      const orderBookResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/order-book?xudtTypeHash=0x3333333333333333333333333333333333333333333333333333333333333333`);
      assert.equal(orderBookResponse.status, 200);
      const orderBookBody = await orderBookResponse.json();
      assert.equal(orderBookBody.data.items.length, 1);
      assert.equal(orderBookBody.data.items[0].status, "LIVE");

      const tradesResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/trades?xudtTypeHash=0x3333333333333333333333333333333333333333333333333333333333333333`);
      assert.equal(tradesResponse.status, 200);
      const tradesBody = await tradesResponse.json();
      assert.equal(tradesBody.data.items.length, 1);
      assert.equal(tradesBody.data.items[0].settlementTxHash, "0xsettle");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  } finally {
    await mongoose.disconnect();
    await mongod.stop();
  }
});
