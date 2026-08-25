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
  internalBotToken: "test-bot-token",
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

function fakePairOrder(
  label: string,
  direction: "ASK" | "BID",
  udtTypeHash: string,
  tokenAmount: string,
  price: string,
  blockNumber = 0,
  txIndex = 0,
): OrderDoc {
  return {
    label,
    direction,
    xudtTypeHash: udtTypeHash,
    remainingAmount: tokenAmount,
    pricePerToken: new mongoose.Types.Decimal128(price),
    blockNumber,
    txIndex,
  } as unknown as OrderDoc;
}

describe("DexOrderBot.findMatch", () => {
  const bot = new DexOrderBot(config);
  const tokenA = "0xaaaa000000000000000000000000000000000000000000000000000000aaaa";
  const tokenB = "0xbbbb000000000000000000000000000000000000000000000000000000bbbb";

  test("matches a BUY and SELL that share token, amount and price", () => {
    const buy = fakePairOrder("buy", "BID", tokenA, "1000", "500");
    const sell = fakePairOrder("sell", "ASK", tokenA, "1000", "500");

    const match = bot.findMatch([buy, sell]);

    assert.equal((match?.buy as unknown as { label: string })?.label, "buy");
    assert.equal((match?.sell as unknown as { label: string })?.label, "sell");
  });

  test("does not match orders for different tokens, amounts, or prices", () => {
    const buy = fakePairOrder("buy", "BID", tokenA, "1000", "500");
    const wrongToken = fakePairOrder("wrongToken", "ASK", tokenB, "1000", "500");
    const wrongAmount = fakePairOrder("wrongAmount", "ASK", tokenA, "999", "500");
    const wrongPrice = fakePairOrder("wrongPrice", "ASK", tokenA, "1000", "501");

    const match = bot.findMatch([buy, wrongToken, wrongAmount, wrongPrice]);

    assert.equal(match, undefined);
  });

  test("does not match two orders on the same side", () => {
    const sellOne = fakePairOrder("sellOne", "ASK", tokenA, "1000", "500");
    const sellTwo = fakePairOrder("sellTwo", "ASK", tokenA, "1000", "500");

    const match = bot.findMatch([sellOne, sellTwo]);

    assert.equal(match, undefined);
  });

  test("picks the oldest order on each side when multiple match", () => {
    const earlierBuy = fakePairOrder("earlierBuy", "BID", tokenA, "1000", "500", 5, 0);
    const laterBuy = fakePairOrder("laterBuy", "BID", tokenA, "1000", "500", 10, 0);
    const earlierSell = fakePairOrder("earlierSell", "ASK", tokenA, "1000", "500", 5, 0);
    const laterSell = fakePairOrder("laterSell", "ASK", tokenA, "1000", "500", 10, 0);

    const match = bot.findMatch([laterBuy, laterSell, earlierBuy, earlierSell]);

    assert.equal((match?.buy as unknown as { label: string })?.label, "earlierBuy");
    assert.equal((match?.sell as unknown as { label: string })?.label, "earlierSell");
  });
});

describe("DexOrderBot.deserializeLockScriptAndArgs", () => {
  const bot = new DexOrderBot(config);

  function buildArgs(opts: {
    version?: number;
    side: number;
    makerLockHash: string;
    udtTypeHash: string;
    tokenAmount: bigint;
    price: bigint;
  }): `0x${string}` {
    const buf = Buffer.alloc(90);
    buf.writeUInt8(opts.version ?? 1, 0);
    buf.writeUInt8(opts.side, 1);
    Buffer.from(opts.makerLockHash.slice(2), "hex").copy(buf, 2);
    Buffer.from(opts.udtTypeHash.slice(2), "hex").copy(buf, 34);
    buf.writeBigUInt64LE(opts.tokenAmount, 66); // low 8 of the 16-byte LE amount
    buf.writeBigUInt64LE(0n, 74); // high 8 of the 16-byte LE amount (0 for these small test values)
    buf.writeBigUInt64LE(opts.price, 82);
    return `0x${buf.toString("hex")}` as `0x${string}`;
  }

  const makerLockHash = `0x${"11".repeat(32)}` as `0x${string}`;
  const udtTypeHash = `0x${"22".repeat(32)}` as `0x${string}`;

  test("decodes a SELL (ASK) order", () => {
    const args = buildArgs({
      side: 1,
      makerLockHash,
      udtTypeHash,
      tokenAmount: 1000n,
      price: 500n,
    });

    const decoded = bot.deserializeLockScriptAndArgs({
      codeHash: config.dexOrderLockScript.codeHash,
      hashType: config.dexOrderLockScript.hashType,
      args,
    });

    assert.equal(decoded.direction, "ASK");
    assert.equal(decoded.makerLockHash, makerLockHash);
    assert.equal(decoded.udtTypeHash, udtTypeHash);
    assert.equal(decoded.tokenAmount, 1000n);
    assert.equal(decoded.pricePerToken, 500n);
  });

  test("decodes a BUY (BID) order", () => {
    const args = buildArgs({
      side: 0,
      makerLockHash,
      udtTypeHash,
      tokenAmount: 42n,
      price: 7n,
    });

    const decoded = bot.deserializeLockScriptAndArgs({
      codeHash: config.dexOrderLockScript.codeHash,
      hashType: config.dexOrderLockScript.hashType,
      args,
    });

    assert.equal(decoded.direction, "BID");
  });

  test("rejects args of the wrong length", () => {
    assert.throws(() =>
      bot.deserializeLockScriptAndArgs({
        codeHash: config.dexOrderLockScript.codeHash,
        hashType: config.dexOrderLockScript.hashType,
        args: "0x00",
      }),
    );
  });

  test("rejects an unsupported version byte", () => {
    const args = buildArgs({
      version: 2,
      side: 1,
      makerLockHash,
      udtTypeHash,
      tokenAmount: 1n,
      price: 1n,
    });

    assert.throws(() =>
      bot.deserializeLockScriptAndArgs({
        codeHash: config.dexOrderLockScript.codeHash,
        hashType: config.dexOrderLockScript.hashType,
        args,
      }),
    );
  });

  test("rejects a script from a different code hash", () => {
    const args = buildArgs({
      side: 1,
      makerLockHash,
      udtTypeHash,
      tokenAmount: 1n,
      price: 1n,
    });

    assert.throws(() =>
      bot.deserializeLockScriptAndArgs({
        codeHash: `0x${"00".repeat(32)}`,
        hashType: "data2",
        args,
      }),
    );
  });
});
