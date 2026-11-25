// Tests V2 smart contract order decoding, partial fill matching, and V2 trade settlement in DexOrderBot.
import test from "node:test";
import assert from "node:assert/strict";
import { ccc } from "@ckb-ccc/core";

import DexOrderBot, { type OrderDoc } from "./index.js";
import {
  encodeDexV2Order,
  encodeDexV2MarketConfig,
  type DexV2Order,
  type DexV2MarketConfig,
} from "../utils/dex-v2-codec.js";
import { Hex, Script } from "../types/index.js";

const CKB = 100_000_000n;
const DUMMY_HASH_1 = ("0x" + "11".repeat(32)) as Hex;
const DUMMY_HASH_2 = ("0x" + "22".repeat(32)) as Hex;
const DUMMY_HASH_3 = ("0x" + "33".repeat(32)) as Hex;
const DUMMY_HASH_4 = ("0x" + "44".repeat(32)) as Hex;
const MARKET_CONFIG_HASH = ("0x" + "77".repeat(32)) as Hex;
const treasuryLock = ccc.Script.from({ codeHash: DUMMY_HASH_2, hashType: "type", args: "0x02" });

const dummyLockScript: Script = {
  codeHash: ("0x" + "aa".repeat(32)) as Hex,
  hashType: "data2",
  args: "0x",
};

const mockMarketConfig: DexV2MarketConfig = {
  admin: DUMMY_HASH_1,
  treasury: treasuryLock.hash(),
  base: DUMMY_HASH_3,
  quote: "0x" + "00".repeat(32) as Hex, // native CKB
  makerBps: 10,
  takerBps: 20,
  lotSize: 100n,
  minOrder: 100n,
  maxOrder: 1_000_000n,
  tickNum: 1n,
  tickDen: 1n,
  status: 0,
};

function bareBot(overrides: Record<string, unknown> = {}) {
  const bot = Object.create(DexOrderBot.prototype) as DexOrderBot;
  Object.assign(bot, {
    config: {
      dexOrderLockScript: dummyLockScript,
    },
    ...overrides,
  });
  return bot;
}

test("deserializeLockScriptAndArgs decodes a 243-byte V2 order correctly", () => {
  const v2Order: DexV2Order = {
    side: "BUY",
    kind: "LIMIT",
    owner: DUMMY_HASH_1,
    market: MARKET_CONFIG_HASH,
    nonce: DUMMY_HASH_2,
    priceNum: 50n,
    priceDen: 1n,
    initialBase: 1000n,
    remainingBase: 800n,
    remainingOffer: 40_000n,
    feeReserve: 80n,
    costBudget: 500_0000_0000n,
    maxNetworkFee: 10_000_000n,
    maxRefundFee: 5_000_000n,
    refundAfter: 1_800_000_000n,
    minFill: 100n,
  };

  const encodedArgs = encodeDexV2Order(v2Order);
  const bot = bareBot();

  const decoded = bot.deserializeLockScriptAndArgs({
    codeHash: dummyLockScript.codeHash,
    hashType: dummyLockScript.hashType,
    args: encodedArgs,
  });

  assert.equal(decoded.orderVersion, 2);
  assert.equal(decoded.direction, "BID");
  assert.equal(decoded.makerLockHash, DUMMY_HASH_1);
  assert.equal(decoded.marketConfigHash, MARKET_CONFIG_HASH);
  assert.equal(decoded.tokenAmount, 800n);
  assert.equal(decoded.pricePerToken, 50n);
  assert.equal(decoded.feeReserve, 80n);
  assert.equal(decoded.costBudget, 500_0000_0000n);
  assert.equal(decoded.refundAfter, 1_800_000_000n);
  assert.equal(decoded.minFill, 100n);
});

test("findMatches supports V2 partial fill matching", () => {
  const bot = bareBot();

  const buyOrder = {
    _id: "v2-buy-1",
    direction: "BID",
    orderVersion: 2,
    marketConfigHash: MARKET_CONFIG_HASH,
    remainingBase: "1000",
    remainingAmount: "1000",
    priceNum: "50",
    priceDen: "1",
    pricePerToken: "50",
    minFill: "100",
    blockNumber: "1",
    txIndex: "0",
  } as unknown as OrderDoc;

  const sellOrder = {
    _id: "v2-sell-1",
    direction: "ASK",
    orderVersion: 2,
    marketConfigHash: MARKET_CONFIG_HASH,
    remainingBase: "400", // Sell only has 400, but buy wants 1000
    remainingAmount: "400",
    priceNum: "50",
    priceDen: "1",
    pricePerToken: "50",
    minFill: "100",
    blockNumber: "2",
    txIndex: "0",
  } as unknown as OrderDoc;

  const matches = bot.findMatches([buyOrder, sellOrder]);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].buy._id, "v2-buy-1");
  assert.equal(matches[0].sell._id, "v2-sell-1");
});

test("findMatches supports V2 price crossing (buy price >= sell price)", () => {
  const bot = bareBot();

  const aggressiveBuy = {
    _id: "v2-buy-aggr",
    direction: "BID",
    orderVersion: 2,
    marketConfigHash: MARKET_CONFIG_HASH,
    remainingBase: "500",
    remainingAmount: "500",
    priceNum: "60", // Buyer is willing to pay 60
    priceDen: "1",
    pricePerToken: "60",
    minFill: "100",
    blockNumber: "1",
    txIndex: "0",
  } as unknown as OrderDoc;

  const cheapSell = {
    _id: "v2-sell-cheap",
    direction: "ASK",
    orderVersion: 2,
    marketConfigHash: MARKET_CONFIG_HASH,
    remainingBase: "500",
    remainingAmount: "500",
    priceNum: "50", // Seller only asks 50
    priceDen: "1",
    pricePerToken: "50",
    minFill: "100",
    blockNumber: "2",
    txIndex: "0",
  } as unknown as OrderDoc;

  const matches = bot.findMatches([aggressiveBuy, cheapSell]);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].buy._id, "v2-buy-aggr");
  assert.equal(matches[0].sell._id, "v2-sell-cheap");
});

test("findMatches rejects V2 orders that do not cross price or meet minFill", () => {
  const bot = bareBot();

  const lowBuy = {
    _id: "v2-buy-low",
    direction: "BID",
    orderVersion: 2,
    marketConfigHash: MARKET_CONFIG_HASH,
    remainingBase: "500",
    remainingAmount: "500",
    priceNum: "45", // Buyer only offers 45
    priceDen: "1",
    pricePerToken: "45",
    minFill: "100",
    blockNumber: "1",
    txIndex: "0",
  } as unknown as OrderDoc;

  const highSell = {
    _id: "v2-sell-high",
    direction: "ASK",
    orderVersion: 2,
    marketConfigHash: MARKET_CONFIG_HASH,
    remainingBase: "500",
    remainingAmount: "500",
    priceNum: "50", // Seller wants 50
    priceDen: "1",
    pricePerToken: "50",
    minFill: "100",
    blockNumber: "2",
    txIndex: "0",
  } as unknown as OrderDoc;

  // Price does not cross
  const noMatches = bot.findMatches([lowBuy, highSell]);
  assert.equal(noMatches.length, 0);

  // Remaining fill below minFill
  const largeMinFillBuy = {
    ...lowBuy,
    priceNum: "50",
    minFill: "600", // requires at least 600
  } as unknown as OrderDoc;

  const minFillRejected = bot.findMatches([largeMinFillBuy, highSell]);
  assert.equal(minFillRejected.length, 0);
});

test("executeV2Trade builds and submits a V2 settlement transaction", async () => {
  const v2BuyOrder: DexV2Order = {
    side: "BUY",
    kind: "LIMIT",
    owner: DUMMY_HASH_1,
    market: MARKET_CONFIG_HASH,
    nonce: DUMMY_HASH_2,
    priceNum: 50n,
    priceDen: 1n,
    initialBase: 500n,
    remainingBase: 500n,
    remainingOffer: 25_000n,
    feeReserve: 50n,
    costBudget: 50_000_000_000n,
    maxNetworkFee: 10_000_000n,
    maxRefundFee: 5_000_000n,
    refundAfter: 1_800_000_000n,
    minFill: 100n,
  };

  const v2SellOrder: DexV2Order = {
    side: "SELL",
    kind: "LIMIT",
    owner: DUMMY_HASH_4,
    market: MARKET_CONFIG_HASH,
    nonce: ("0x" + "b".repeat(64)) as Hex,
    priceNum: 50n,
    priceDen: 1n,
    initialBase: 500n,
    remainingBase: 500n,
    remainingOffer: 500n,
    feeReserve: 0n,
    costBudget: 50_000_000_000n,
    maxNetworkFee: 10_000_000n,
    maxRefundFee: 5_000_000n,
    refundAfter: 1_800_000_000n,
    minFill: 100n,
  };

  const buyDoc = {
    _id: "buy-v2",
    direction: "BID",
    orderVersion: 2,
    marketConfigHash: MARKET_CONFIG_HASH,
    ownerLockHash: DUMMY_HASH_1,
    ownerLock: { codeHash: DUMMY_HASH_1, hashType: "type", args: "0x01" },
    lockScript: { codeHash: dummyLockScript.codeHash, hashType: "data2", args: encodeDexV2Order(v2BuyOrder) },
    outPoint: { txHash: ("0x" + "1".repeat(64)) as Hex, index: "0" },
    capacity: (100n * CKB).toString(),
    remainingAmount: "500",
    pricePerToken: "50",
    blockNumber: "100",
  } as unknown as OrderDoc;

  const sellDoc = {
    _id: "sell-v2",
    direction: "ASK",
    orderVersion: 2,
    marketConfigHash: MARKET_CONFIG_HASH,
    ownerLockHash: DUMMY_HASH_4,
    ownerLock: { codeHash: DUMMY_HASH_4, hashType: "type", args: "0x02" },
    lockScript: { codeHash: dummyLockScript.codeHash, hashType: "data2", args: encodeDexV2Order(v2SellOrder) },
    outPoint: { txHash: ("0x" + "2".repeat(64)) as Hex, index: "0" },
    capacity: (100n * CKB).toString(),
    cellData: "0x",
    remainingAmount: "500",
    pricePerToken: "50",
    blockNumber: "101",
  } as unknown as OrderDoc;

  const submittedTxs: ccc.Transaction[] = [];
  const dexCellDep: ccc.CellDepLike = {
    outPoint: { txHash: ("0x" + "aa".repeat(32)) as Hex, index: 0 },
    depType: "code",
  };
  const xudtCellDep: ccc.CellDepLike = {
    outPoint: { txHash: ("0x" + "bb".repeat(32)) as Hex, index: 0 },
    depType: "code",
  };
  const marketConfigCellDep: ccc.CellDepLike = {
    outPoint: { txHash: ("0x" + "cc".repeat(32)) as Hex, index: 0 },
    depType: "code",
  };

  const bot = bareBot({
    dexCellDeps: [dexCellDep],
    xudtCellDeps: [xudtCellDep],
    resolveMarketConfig: async () => ({ config: mockMarketConfig, cellDep: marketConfigCellDep, treasuryLock }),
    reserve: async (id: string) => (id === "buy-v2" ? buyDoc : sellDoc),
    checkOrderLiveness: async () => true,
    submit: async (tx: ccc.Transaction) => {
      submittedTxs.push(tx);
      return ("0x" + "ff".repeat(32)) as Hex;
    },
    ingestionService: {
      ingest: async () => ({ status: "APPLIED" }),
    },
  });

  const txHash = await bot.executeTrade(buyDoc, sellDoc);
  assert.equal(txHash, "0x" + "ff".repeat(32));
  assert.equal(submittedTxs.length, 1);

  const tx = submittedTxs[0];
  assert.equal(tx.inputs.length, 2);
  // Contains outputs for payouts, treasury output, etc.
  assert.ok(tx.outputs.length >= 3);
  // Cell deps include dexCellDep, marketConfigCellDep, and xudtCellDeps
  assert.ok(tx.cellDeps.length >= 3);
  assert.ok(tx.outputs.some((output) => output.lock.hash() === mockMarketConfig.treasury));
});

test("findMatches ignores V2 orders with insufficient cost budget (< 31 CKB)", () => {
  const bot = bareBot();

  const underfundedSell = {
    _id: "v2-sell-underfunded",
    direction: "ASK",
    orderVersion: 2,
    marketConfigHash: MARKET_CONFIG_HASH,
    remainingBase: "500",
    remainingAmount: "500",
    priceNum: "50",
    priceDen: "1",
    pricePerToken: "50",
    costBudget: (100_000_000n).toString(), // 1 CKB (insufficient for ~30.5 CKB share)
    minFill: "100",
    blockNumber: "1",
    txIndex: "0",
  } as unknown as OrderDoc;

  const validSell = {
    _id: "v2-sell-valid",
    direction: "ASK",
    orderVersion: 2,
    marketConfigHash: MARKET_CONFIG_HASH,
    remainingBase: "500",
    remainingAmount: "500",
    priceNum: "50",
    priceDen: "1",
    pricePerToken: "50",
    costBudget: (100n * 100_000_000n).toString(), // 100 CKB
    minFill: "100",
    blockNumber: "2",
    txIndex: "0",
  } as unknown as OrderDoc;

  const validBuy = {
    _id: "v2-buy-valid",
    direction: "BID",
    orderVersion: 2,
    marketConfigHash: MARKET_CONFIG_HASH,
    remainingBase: "500",
    remainingAmount: "500",
    priceNum: "50",
    priceDen: "1",
    pricePerToken: "50",
    costBudget: (100n * 100_000_000n).toString(), // 100 CKB
    minFill: "100",
    blockNumber: "3",
    txIndex: "0",
  } as unknown as OrderDoc;

  const matches = bot.findMatches([underfundedSell, validSell, validBuy]);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].buy._id, "v2-buy-valid");
  assert.equal(matches[0].sell._id, "v2-sell-valid");
});
