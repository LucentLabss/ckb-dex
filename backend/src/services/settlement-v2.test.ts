import { test } from "node:test";
import assert from "node:assert/strict";
import { buildV2Settlement, SettlementInputOrder } from "./settlement-v2.js";
import {
  DexV2Order,
  DexV2MarketConfig,
  decodeDexV2SettlementWitness,
  NATIVE_ASSET_HASH,
} from "../utils/dex-v2-codec.js";
import { ccc } from "@ckb-ccc/core";
import { Hex } from "../types/index.js";

const DUMMY_HASH_1 = "0x1111111111111111111111111111111111111111111111111111111111111111";
const DUMMY_HASH_2 = "0x2222222222222222222222222222222222222222222222222222222222222222";
const DUMMY_HASH_3 = "0x3333333333333333333333333333333333333333333333333333333333333333";
const DUMMY_HASH_4 = "0x4444444444444444444444444444444444444444444444444444444444444444";
const treasuryLock = ccc.Script.from({ codeHash: DUMMY_HASH_2, hashType: "type", args: `0x${"22".repeat(20)}` });

const mockMarket: DexV2MarketConfig = {
  admin: DUMMY_HASH_1,
  treasury: treasuryLock.hash(),
  base: DUMMY_HASH_3,
  quote: NATIVE_ASSET_HASH,
  makerBps: 10,
  takerBps: 20,
  lotSize: 100n,
  minOrder: 100n,
  maxOrder: 1_000_000n,
  tickNum: 1n,
  tickDen: 1n,
  status: 0,
};

const dummyCellDep: ccc.CellDepLike = {
  outPoint: {
    txHash: "0x" + "a".repeat(64),
    index: 0,
  },
  depType: "code",
};

test("buildV2Settlement builds 2-order full fill outputs with witness and treasury", () => {
  const buyOrder: DexV2Order = {
    side: "BUY",
    kind: "LIMIT",
    owner: DUMMY_HASH_1,
    market: DUMMY_HASH_2,
    nonce: DUMMY_HASH_3,
    priceNum: 50n,
    priceDen: 1n,
    initialBase: 500n,
    remainingBase: 500n,
    remainingOffer: 25_000n,
    feeReserve: 50n,
    costBudget: 50_000_000_000n, // 500 CKB
    maxNetworkFee: 10_000_000n,
    maxRefundFee: 5_000_000n,
    refundAfter: 1_800_000_000n,
    minFill: 100n,
  };

  const sellOrder: DexV2Order = {
    side: "SELL",
    kind: "LIMIT",
    owner: DUMMY_HASH_4,
    market: DUMMY_HASH_2,
    nonce: ("0x" + "b".repeat(64)) as Hex,
    priceNum: 50n,
    priceDen: 1n,
    initialBase: 500n,
    remainingBase: 500n,
    remainingOffer: 500n,
    feeReserve: 0n,
    costBudget: 50_000_000_000n, // 500 CKB
    maxNetworkFee: 10_000_000n,
    maxRefundFee: 5_000_000n,
    refundAfter: 1_800_000_000n,
    minFill: 100n,
  };

  const orders: SettlementInputOrder[] = [
    {
      order: buyOrder,
      outPoint: { txHash: "0x" + "1".repeat(64), index: 0 },
      cellCapacity: 100_0000_0000n,
      ownerLock: { codeHash: DUMMY_HASH_1, hashType: "type", args: "0x01" },
      cellData: "0x",
    },
    {
      order: sellOrder,
      outPoint: { txHash: "0x" + "2".repeat(64), index: 0 },
      cellCapacity: 100_0000_0000n,
      ownerLock: { codeHash: DUMMY_HASH_4, hashType: "type", args: "0x02" },
      cellData: "0x",
    },
  ];

  const result = buildV2Settlement({
    orders,
    takerIndex: 0,
    market: mockMarket,
    treasuryLock,
    dexOrderLockCellDep: dummyCellDep,
    marketConfigCellDep: dummyCellDep,
    xudtCellDeps: [dummyCellDep],
  });

  assert.equal(result.tx.inputs.length, 2);
  assert.equal(result.fills.length, 2);
  // Full fill: no successor outputs
  assert.equal(result.fills[0].successor, 0xffffffff);
  assert.equal(result.fills[1].successor, 0xffffffff);

  // WitnessArgs in input 0
  assert.equal(result.tx.witnesses.length, 1);
  const witnessArgs = ccc.WitnessArgs.fromBytes(result.tx.witnesses[0]);
  assert.ok(witnessArgs.lock);

  // Decode settlement witness
  const decoded = decodeDexV2SettlementWitness(witnessArgs.lock);
  assert.equal(decoded.takerIndex, 0);
  assert.equal(decoded.fills.length, 2);
  assert.equal(decoded.fills[0].base, 500n);
  assert.equal(decoded.fills[0].quote, 25_000n);

  // Treasury fees: taker 20 bps = 50, maker 10 bps = 25 -> total 75
  assert.equal(result.totalFees, 75n);
  assert.notEqual(result.treasuryOutputIndex, 0xffffffff);
  assert.equal(result.tx.outputs[result.treasuryOutputIndex].lock.hash(), mockMarket.treasury);
  assert.equal(result.tx.outputs[result.treasuryOutputIndex].lock.args, treasuryLock.args);
});

test("buildV2Settlement handles partial fill and creates successor cell", () => {
  const buyOrder: DexV2Order = {
    side: "BUY",
    kind: "LIMIT",
    owner: DUMMY_HASH_1,
    market: DUMMY_HASH_2,
    nonce: DUMMY_HASH_3,
    priceNum: 50n,
    priceDen: 1n,
    initialBase: 1000n,
    remainingBase: 1000n, // Buy wants 1000
    remainingOffer: 50_000n,
    feeReserve: 100n,
    costBudget: 50_000_000_000n, // 500 CKB
    maxNetworkFee: 10_000_000n,
    maxRefundFee: 5_000_000n,
    refundAfter: 1_800_000_000n,
    minFill: 100n,
  };

  const sellOrder: DexV2Order = {
    side: "SELL",
    kind: "LIMIT",
    owner: DUMMY_HASH_4,
    market: DUMMY_HASH_2,
    nonce: ("0x" + "b".repeat(64)) as Hex,
    priceNum: 50n,
    priceDen: 1n,
    initialBase: 400n,
    remainingBase: 400n, // Sell only has 400
    remainingOffer: 400n,
    feeReserve: 0n,
    costBudget: 50_000_000_000n, // 500 CKB
    maxNetworkFee: 10_000_000n,
    maxRefundFee: 5_000_000n,
    refundAfter: 1_800_000_000n,
    minFill: 100n,
  };

  const orders: SettlementInputOrder[] = [
    {
      order: buyOrder,
      outPoint: { txHash: "0x" + "1".repeat(64), index: 0 },
      cellCapacity: buyOrder.remainingOffer + buyOrder.feeReserve + 1000n * 100_000_000n,
      ownerLock: { codeHash: DUMMY_HASH_1, hashType: "type", args: "0x01" },
      cellData: "0x",
    },
    {
      order: sellOrder,
      outPoint: { txHash: "0x" + "2".repeat(64), index: 0 },
      cellCapacity: 1000n * 100_000_000n,
      ownerLock: { codeHash: DUMMY_HASH_4, hashType: "type", args: "0x02" },
      cellData: "0x",
    },
  ];

  const result = buildV2Settlement({
    orders,
    takerIndex: 0,
    market: mockMarket,
    treasuryLock,
    dexOrderLockCellDep: dummyCellDep,
    marketConfigCellDep: dummyCellDep,
    xudtCellDeps: [dummyCellDep],
  });

  // Fills 400 base
  assert.equal(result.fills[0].base, 400n);
  // Buy has 600 remaining -> successor output created!
  assert.notEqual(result.fills[0].successor, 0xffffffff);
  // Sell fully filled -> no successor
  assert.equal(result.fills[1].successor, 0xffffffff);
});

function treasuryFixture(lock: ccc.ScriptLike = treasuryLock, priceNum = 50n) {
  const baseType = ccc.Script.from({ codeHash: DUMMY_HASH_3, hashType: "type", args: "0x03" });
  const common = {
    kind: "LIMIT" as const,
    market: DUMMY_HASH_2,
    nonce: DUMMY_HASH_3,
    priceNum,
    priceDen: 1n,
    initialBase: 500n,
    remainingBase: 500n,
    costBudget: 500n * 100_000_000n,
    maxNetworkFee: 10_000_000n,
    maxRefundFee: 5_000_000n,
    refundAfter: 1_800_000_000n,
    minFill: 100n,
  } as const;
  const buy: DexV2Order = {
    ...common, side: "BUY", owner: DUMMY_HASH_1,
    remainingOffer: 500n * priceNum, feeReserve: priceNum,
  };
  const sell: DexV2Order = {
    ...common, side: "SELL", owner: DUMMY_HASH_4,
    remainingOffer: 500n, feeReserve: 0n,
  };
  const orders: SettlementInputOrder[] = [
    {
      order: buy, outPoint: { txHash: DUMMY_HASH_1, index: 0 },
      cellCapacity: buy.remainingOffer + buy.feeReserve + 1000n * 100_000_000n,
      ownerLock: { codeHash: DUMMY_HASH_1, hashType: "type", args: "0x01" }, cellData: "0x",
    },
    {
      order: sell, outPoint: { txHash: DUMMY_HASH_4, index: 0 },
      cellCapacity: 1000n * 100_000_000n,
      ownerLock: { codeHash: DUMMY_HASH_4, hashType: "type", args: "0x04" },
      typeScript: baseType, cellData: ccc.hexFrom(ccc.numLeToBytes(500n, 16)),
    },
  ];
  return {
    orders, takerIndex: 0,
    market: { ...mockMarket, base: baseType.hash(), treasury: ccc.Script.from(lock).hash() },
    treasuryLock: lock,
    dexOrderLockCellDep: dummyCellDep,
    marketConfigCellDep: dummyCellDep,
    xudtCellDeps: [dummyCellDep],
  };
}

test("treasury payment uses the full supplied script and funds only its required storage", () => {
  const params = treasuryFixture();
  const result = buildV2Settlement(params);
  const output = result.tx.outputs[result.treasuryOutputIndex];
  const occupied = ccc.CellOutput.from({ lock: treasuryLock }, "0x").capacity;
  assert.equal(output.lock.hash(), params.market.treasury);
  assert.equal(output.lock.codeHash, treasuryLock.codeHash);
  assert.equal(output.lock.args, treasuryLock.args);
  assert.equal(output.capacity, occupied);
  assert.equal(result.tx.outputsData[result.treasuryOutputIndex], "0x");
  assert.equal(result.fills.reduce((sum, fill) => sum + fill.treasuryCapacity, 0n), occupied - result.totalFees);
});

test("a different treasury script is rejected even if its code hash matches", () => {
  const params = treasuryFixture();
  params.treasuryLock = { codeHash: treasuryLock.codeHash, hashType: treasuryLock.hashType, args: "0x" };
  assert.throws(() => buildV2Settlement(params), /Treasury lock script does not match/);
});

test("native trading fees that cover treasury storage do not charge another storage reserve", () => {
  const params = treasuryFixture(treasuryLock, 200n * 100_000_000n);
  const result = buildV2Settlement(params);
  assert.ok(result.totalFees > ccc.CellOutput.from({ lock: treasuryLock }, "0x").capacity);
  assert.equal(result.tx.outputs[result.treasuryOutputIndex].capacity, result.totalFees);
  assert.ok(result.fills.every((fill) => fill.treasuryCapacity === 0n));
});

test("treasury occupied capacity is calculated from the actual lock script", () => {
  const largerLock = ccc.Script.from({ codeHash: treasuryLock.codeHash, hashType: treasuryLock.hashType, args: "0x" + "11".repeat(40) });
  const result = buildV2Settlement(treasuryFixture(largerLock));
  const occupied = ccc.CellOutput.from({ lock: largerLock }, "0x").capacity;
  assert.ok(occupied > ccc.CellOutput.from({ lock: treasuryLock }, "0x").capacity);
  assert.equal(result.tx.outputs[result.treasuryOutputIndex].capacity, occupied);
  assert.equal(result.fills.reduce((sum, fill) => sum + fill.treasuryCapacity, 0n), occupied - result.totalFees);
});

test("token treasury fees use the quote token type and include token-cell storage", () => {
  const params = treasuryFixture();
  const quoteType = ccc.Script.from({ codeHash: DUMMY_HASH_4, hashType: "type", args: "0x1234" });
  params.market.quote = quoteType.hash();
  params.orders[0].typeScript = quoteType;
  params.orders.reverse(); // The first input now holds base tokens, not quote tokens.
  const result = buildV2Settlement(params);
  const index = result.treasuryOutputIndex;
  const output = result.tx.outputs[index];
  const data = ccc.hexFrom(ccc.numLeToBytes(result.totalFees, 16));
  const occupied = ccc.CellOutput.from({ lock: treasuryLock, type: quoteType }, data).capacity;
  assert.equal(output.lock.hash(), params.market.treasury);
  assert.equal(output.type?.hash(), quoteType.hash());
  assert.equal(result.tx.outputsData[index], data);
  assert.equal(output.capacity, occupied);
  assert.equal(result.fills.reduce((sum, fill) => sum + fill.treasuryCapacity, 0n), occupied);
});

test("token treasury fees reject a missing quote type rather than using an unrelated token", () => {
  const params = treasuryFixture();
  params.market.quote = DUMMY_HASH_4;
  assert.throws(() => buildV2Settlement(params), /Missing quote asset type script/);
});

test("zero trading fees do not create or charge for a treasury output", () => {
  const params = treasuryFixture();
  params.market.makerBps = 0;
  params.market.takerBps = 0;
  const result = buildV2Settlement(params);
  assert.equal(result.totalFees, 0n);
  assert.equal(result.treasuryOutputIndex, 0xffffffff);
  assert.ok(result.fills.every((fill) => fill.treasuryCapacity === 0n));
});

test("partial-fill successor uses dexOrderLock script and not ownerLock", () => {
  const DEX_LOCK_CODE_HASH = ("0x" + "88".repeat(32)) as Hex;
  const OWNER_LOCK_CODE_HASH = ("0x" + "11".repeat(32)) as Hex;

  const buyOrder: DexV2Order = {
    side: "BUY",
    kind: "LIMIT",
    owner: DUMMY_HASH_1,
    market: DUMMY_HASH_2,
    nonce: DUMMY_HASH_3,
    priceNum: 50n,
    priceDen: 1n,
    initialBase: 1000n,
    remainingBase: 1000n,
    remainingOffer: 50_000n,
    feeReserve: 100n,
    costBudget: 50_000_000_000n,
    maxNetworkFee: 10_000_000n,
    maxRefundFee: 5_000_000n,
    refundAfter: 1_800_000_000n,
    minFill: 100n,
  };

  const sellOrder: DexV2Order = {
    side: "SELL",
    kind: "LIMIT",
    owner: DUMMY_HASH_4,
    market: DUMMY_HASH_2,
    nonce: ("0x" + "b".repeat(64)) as Hex,
    priceNum: 50n,
    priceDen: 1n,
    initialBase: 400n,
    remainingBase: 400n,
    remainingOffer: 400n,
    feeReserve: 0n,
    costBudget: 50_000_000_000n,
    maxNetworkFee: 10_000_000n,
    maxRefundFee: 5_000_000n,
    refundAfter: 1_800_000_000n,
    minFill: 100n,
  };

  const orders: SettlementInputOrder[] = [
    {
      order: buyOrder,
      outPoint: { txHash: "0x" + "1".repeat(64), index: 0 },
      cellCapacity: buyOrder.remainingOffer + buyOrder.feeReserve + 1000n * 100_000_000n,
      ownerLock: { codeHash: OWNER_LOCK_CODE_HASH, hashType: "type", args: "0x01" },
      orderLock: { codeHash: DEX_LOCK_CODE_HASH, hashType: "data2", args: "0x" },
      cellData: "0x",
    },
    {
      order: sellOrder,
      outPoint: { txHash: "0x" + "2".repeat(64), index: 0 },
      cellCapacity: 1000n * 100_000_000n,
      ownerLock: { codeHash: DUMMY_HASH_4, hashType: "type", args: "0x02" },
      orderLock: { codeHash: DEX_LOCK_CODE_HASH, hashType: "data2", args: "0x" },
      cellData: "0x",
    },
  ];

  const result = buildV2Settlement({
    orders,
    takerIndex: 0,
    market: mockMarket,
    treasuryLock,
    dexOrderLock: { codeHash: DEX_LOCK_CODE_HASH, hashType: "data2", args: "0x" },
    dexOrderLockCellDep: dummyCellDep,
    marketConfigCellDep: dummyCellDep,
    xudtCellDeps: [dummyCellDep],
  });

  const successorIdx = result.fills[0].successor;
  assert.notEqual(successorIdx, 0xffffffff);
  const successorOutput = result.tx.outputs[successorIdx];

  // Successor lock must match DEX order lock, NOT the owner lock
  assert.equal(successorOutput.lock.codeHash, DEX_LOCK_CODE_HASH);
  assert.equal(successorOutput.lock.hashType, "data2");
  assert.notEqual(successorOutput.lock.codeHash, OWNER_LOCK_CODE_HASH);
});

test("buyer payout cell includes unspent capacity refund matching smart contract accounting", () => {
  const params = treasuryFixture();
  const buyInput = params.orders[0];
  const initialCapacity = buyInput.cellCapacity;

  const result = buildV2Settlement(params);
  const buyFill = result.fills[0];
  const buyerPayout = result.tx.outputs[buyFill.payout];

  // Smart contract rule:
  // expected_capacity = original_capacity + native_received - native_spent
  // accounted = returned_capacity + cost
  // expected_capacity == accounted
  const fillQuote = buyFill.quote;
  const takerFeeRate = BigInt(params.market.takerBps);
  const takerFee = (fillQuote * takerFeeRate) / 10000n;
  const nativeSpent = fillQuote + takerFee;
  const expectedCapacity = initialCapacity - nativeSpent;
  const cost = buyFill.networkFee + buyFill.treasuryCapacity;

  // Accounted returned capacity = payout capacity (for full fill)
  assert.equal(buyerPayout.capacity, expectedCapacity - cost);
  assert.equal(buyerPayout.capacity + cost, expectedCapacity);
  assert.ok(buyerPayout.capacity > 61_0000_0000n); // Much larger than bare minimum cell capacity
});

