// Run with: npx tsx --test src/bot/index.test.ts
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import type { Config } from "../types";
import DexOrderBot, { OrderDoc } from "./index.js";

// Must match the "dex-order-lock" entry in deployment/scripts.json so the bot's
// constructor can resolve its cell deps without touching the network.
const config: Config = {
  mongodbUrl: "mongodb://127.0.0.1:27017/test",
  ckbRpcUrl: "http://127.0.0.1:8114",
  enviroment: "development",
  dexOrderLockScript: {
    codeHash: "0x2ac318d6f1593c62bda4575a4151f9026a4451005360149f746e28524ca3d980",
    hashType: "data2",
    args: "0x",
  },
  port: 3000,
  apiVersion: 1,
};

function fakeOrder(
  label: string,
  direction: "ASK" | "BID",
  price: string,
  blockNumber = 0,
  txIndex = 0,
): OrderDoc {
  return {
    label,
    direction,
    pricePerToken: new mongoose.Types.Decimal128(price),
    blockNumber,
    txIndex,
  } as unknown as OrderDoc;
}

const labelsOf = (orders: OrderDoc[]) =>
  orders.map((order) => (order as unknown as { label: string }).label);

describe("DexOrderBot.sort", () => {
  const bot = new DexOrderBot(config);

  test("ranks ASKs cheapest-first", () => {
    const expensive = fakeOrder("expensive", "ASK", "500");
    const cheap = fakeOrder("cheap", "ASK", "100");

    assert.deepEqual(labelsOf(bot.sort([expensive, cheap])), ["cheap", "expensive"]);
  });

  test("ranks BIDs highest-first", () => {
    const low = fakeOrder("low", "BID", "100");
    const high = fakeOrder("high", "BID", "500");

    assert.deepEqual(labelsOf(bot.sort([low, high])), ["high", "low"]);
  });

  test("puts every ASK ahead of every BID regardless of price", () => {
    const bid = fakeOrder("bid", "BID", "1000");
    const ask = fakeOrder("ask", "ASK", "1000");

    assert.deepEqual(labelsOf(bot.sort([bid, ask])), ["ask", "bid"]);
  });

  test("breaks equal prices by chain order: block number, then tx index", () => {
    const later = fakeOrder("later", "ASK", "100", 10, 1);
    const sameBlockEarlier = fakeOrder("sameBlockEarlier", "ASK", "100", 10, 0);
    const earliestBlock = fakeOrder("earliestBlock", "ASK", "100", 5, 9);

    assert.deepEqual(labelsOf(bot.sort([later, sameBlockEarlier, earliestBlock])), [
      "earliestBlock",
      "sameBlockEarlier",
      "later",
    ]);
  });

  test("does not mutate the input array", () => {
    const a = fakeOrder("a", "ASK", "500");
    const b = fakeOrder("b", "ASK", "100");
    const input = [a, b];

    bot.sort(input);

    assert.deepEqual(labelsOf(input), ["a", "b"]);
  });
});
