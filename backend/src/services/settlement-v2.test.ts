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

const mockMarket: DexV2MarketConfig = {
  admin: DUMMY_HASH_1,
  treasury: DUMMY_HASH_2,
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

test("buildV2Settlement builds a valid 2-order full fill settlement transaction with witness and treasury", () => {
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
