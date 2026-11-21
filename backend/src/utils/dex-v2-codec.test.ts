import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decodeDexV2Order,
  encodeDexV2Order,
  validateDexV2Order,
  decodeDexV2MarketConfig,
  encodeDexV2MarketConfig,
  encodeDexV2SettlementWitness,
  decodeDexV2SettlementWitness,
  encodeDexV2RefundWitness,
  decodeDexV2RefundWitness,
  calcOrderEscrow,
  getOfferedAsset,
  getReceivedAsset,
  ceilDiv,
  ORDER_ARGS_LEN,
  MARKET_CONFIG_LEN,
  INDEX_NONE,
  NATIVE_ASSET_HASH,
  type DexV2Order,
  type DexV2MarketConfig,
  type DexV2SettlementWitness,
  type DexV2RefundWitness,
} from "./dex-v2-codec.js";
import { byteLength } from "./shared.js";

const DUMMY_HASH_1 = "0x1111111111111111111111111111111111111111111111111111111111111111";
const DUMMY_HASH_2 = "0x2222222222222222222222222222222222222222222222222222222222222222";
const DUMMY_HASH_3 = "0x3333333333333333333333333333333333333333333333333333333333333333";
const DUMMY_HASH_4 = "0x4444444444444444444444444444444444444444444444444444444444444444";

const mockMarketConfig: DexV2MarketConfig = {
  admin: DUMMY_HASH_1,
  treasury: DUMMY_HASH_2,
  base: DUMMY_HASH_3,
  quote: NATIVE_ASSET_HASH, // quote is native CKB
  makerBps: 10,
  takerBps: 20,
  lotSize: 100n,
  minOrder: 100n,
  maxOrder: 1_000_000n,
  tickNum: 1n,
  tickDen: 1n,
  status: 0,
};

test("DexV2MarketConfig encodes to exactly 214 bytes and roundtrips perfectly", () => {
  const encoded = encodeDexV2MarketConfig(mockMarketConfig);
  assert.equal(byteLength(encoded), MARKET_CONFIG_LEN);

  const decoded = decodeDexV2MarketConfig(encoded);
  assert.deepEqual(decoded, mockMarketConfig);
});

test("DexV2MarketConfig rejects invalid configurations", () => {
  assert.throws(() => decodeDexV2MarketConfig(encodeDexV2MarketConfig({
    ...mockMarketConfig,
    base: mockMarketConfig.quote, // base and quote identical
  })));

  assert.throws(() => decodeDexV2MarketConfig(encodeDexV2MarketConfig({
    ...mockMarketConfig,
    makerBps: 10_001, // exceeds 10000 bps
  })));

  assert.throws(() => decodeDexV2MarketConfig(encodeDexV2MarketConfig({
    ...mockMarketConfig,
    lotSize: 0n,
  })));
});

test("DexV2Order encodes to exactly 243 bytes and roundtrips perfectly for a sell order", () => {
  const sellOrder: DexV2Order = {
    side: "SELL",
    kind: "LIMIT",
    owner: DUMMY_HASH_1,
    market: DUMMY_HASH_2,
    nonce: DUMMY_HASH_4,
    priceNum: 50n,
    priceDen: 1n,
    initialBase: 1000n,
    remainingBase: 1000n,
    remainingOffer: 1000n, // for sell, offered is base
    feeReserve: 0n,        // sells do not escrow fee reserve
    costBudget: 200_000_000n,
    maxNetworkFee: 10_000_000n,
    maxRefundFee: 5_000_000n,
    refundAfter: 1_800_000_000n,
    minFill: 100n,
  };

  const encoded = encodeDexV2Order(sellOrder);
  assert.equal(byteLength(encoded), ORDER_ARGS_LEN);

  const decoded = decodeDexV2Order(encoded);
  assert.deepEqual(decoded, sellOrder);

  // Validate against market config
  assert.doesNotThrow(() => validateDexV2Order(decoded, mockMarketConfig));
  assert.equal(calcOrderEscrow(decoded), 1000n);
  assert.equal(getOfferedAsset(decoded, mockMarketConfig), mockMarketConfig.base);
  assert.equal(getReceivedAsset(decoded, mockMarketConfig), mockMarketConfig.quote);
});

test("DexV2Order encodes and validates a buy order with quote budget and fee reserve", () => {
  const qty = 500n;
  const price = 50n;
  const requiredQuote = qty * price; // 25,000
  // Worst rate is 20 bps = 0.2% = 50
  const worstRate = BigInt(Math.max(mockMarketConfig.makerBps, mockMarketConfig.takerBps));
  const feeReserve = ceilDiv(requiredQuote * worstRate, 10_000n);

  const buyOrder: DexV2Order = {
    side: "BUY",
    kind: "LIMIT",
    owner: DUMMY_HASH_1,
    market: DUMMY_HASH_2,
    nonce: DUMMY_HASH_4,
    priceNum: price,
    priceDen: 1n,
    initialBase: qty,
    remainingBase: qty,
    remainingOffer: requiredQuote,
    feeReserve,
    costBudget: 300_000_000n,
    maxNetworkFee: 10_000_000n,
    maxRefundFee: 5_000_000n,
    refundAfter: 1_800_000_000n,
    minFill: 100n,
  };

  const encoded = encodeDexV2Order(buyOrder);
  assert.equal(byteLength(encoded), ORDER_ARGS_LEN);

  const decoded = decodeDexV2Order(encoded);
  assert.deepEqual(decoded, buyOrder);

  assert.doesNotThrow(() => validateDexV2Order(decoded, mockMarketConfig));
  assert.equal(calcOrderEscrow(decoded), requiredQuote + feeReserve);
  assert.equal(getOfferedAsset(decoded, mockMarketConfig), mockMarketConfig.quote);
  assert.equal(getReceivedAsset(decoded, mockMarketConfig), mockMarketConfig.base);
});

test("DexV2Order rejects invalid parameters", () => {
  const invalidOrder: DexV2Order = {
    side: "SELL",
    kind: "LIMIT",
    owner: NATIVE_ASSET_HASH, // zero owner hash rejected
    market: DUMMY_HASH_2,
    nonce: DUMMY_HASH_4,
    priceNum: 50n,
    priceDen: 1n,
    initialBase: 1000n,
    remainingBase: 1000n,
    remainingOffer: 1000n,
    feeReserve: 0n,
    costBudget: 200_000_000n,
    maxNetworkFee: 10_000_000n,
    maxRefundFee: 5_000_000n,
    refundAfter: 0n,
    minFill: 100n,
  };

  assert.throws(() => validateDexV2Order(invalidOrder, mockMarketConfig));
});

test("DexV2SettlementWitness encodes and decodes properly", () => {
  const witness: DexV2SettlementWitness = {
    takerIndex: 0,
    treasuryOutputIndex: 3,
    fills: [
      {
        base: 500n,
        quote: 25_000n,
        payout: 0,
        refund: INDEX_NONE,
        successor: INDEX_NONE,
        networkFee: 100_000n,
        treasuryCapacity: 61_000_000n,
      },
      {
        base: 500n,
        quote: 25_000n,
        payout: 1,
        refund: INDEX_NONE,
        successor: 2, // partial fill has successor
        networkFee: 100_000n,
        treasuryCapacity: 61_000_000n,
      },
    ],
  };

  const encoded = encodeDexV2SettlementWitness(witness);
  // 8 bytes header + 2 fills * 60 bytes = 128 bytes
  assert.equal(byteLength(encoded), 128);

  const decoded = decodeDexV2SettlementWitness(encoded);
  assert.deepEqual(decoded, witness);
});

test("DexV2RefundWitness encodes and decodes cancellation and timed refund", () => {
  const cancelWitness: DexV2RefundWitness = {
    action: "CANCEL",
    refundOutputIndex: 0,
    networkFee: 50_000n,
  };

  const encodedCancel = encodeDexV2RefundWitness(cancelWitness);
  assert.equal(byteLength(encodedCancel), 14);
  assert.deepEqual(decodeDexV2RefundWitness(encodedCancel), cancelWitness);

  const refundWitness: DexV2RefundWitness = {
    action: "REFUND",
    refundOutputIndex: 0,
    networkFee: 60_000n,
  };

  const encodedRefund = encodeDexV2RefundWitness(refundWitness);
  assert.equal(byteLength(encodedRefund), 14);
  assert.deepEqual(decodeDexV2RefundWitness(encodedRefund), refundWitness);
});
