// Serialization, deserialization, and validation for CKB DEX V2 smart contracts.
// Reference: smart-contract/crates/dex-v2-core/src/lib.rs

import AppError from "../services/error.js";
import { Hex } from "../types/index.js";
import { toBuffer, toHex } from "./shared.js";

export const DEX_V2_VERSION = 2;
export const ORDER_ARGS_LEN = 243;
export const MARKET_CONFIG_LEN = 214;
export const INDEX_NONE = 0xffff_ffff;
export const MAX_ORDERS = 16;
export const BPS = 10_000n;
export const NATIVE_ASSET_HASH: Hex = "0x0000000000000000000000000000000000000000000000000000000000000000";

export const SIDE_BUY = 0;
export const SIDE_SELL = 1;

export const KIND_LIMIT = 0;
export const KIND_MARKET = 1;

export const ACTION_SETTLEMENT = 0;
export const ACTION_CANCEL = 1;
export const ACTION_REFUND = 2;

export const STATUS_ACTIVE = 0;
export const STATUS_PAUSED = 1;
export const STATUS_CLOSED = 2;

// Contract exit error codes matching dex-v2-core
export const V2_ERROR_CODES = {
  FORMAT: -40,
  MARKET_ERROR: -41,
  ASSET: -42,
  AMOUNT: -43,
  PRICE: -44,
  FEE: -45,
  CAPACITY: -46,
  BUDGET: -47,
  OUTPUT: -48,
  SUCCESSOR: -49,
  AUTH: -50,
  SINCE: -51,
  COUNT: -52,
  WITNESS: -53,
  OVERFLOW: -54,
  CONFIG: -55,
  STATE: -56,
  MIN_FILL: -57,
  LOAD: -58,
} as const;

export type DexV2Side = "BUY" | "SELL";
export type DexV2Kind = "LIMIT" | "MARKET";

export interface DexV2Order {
  side: DexV2Side;
  kind: DexV2Kind;
  owner: Hex;
  market: Hex;
  nonce: Hex;
  priceNum: bigint;
  priceDen: bigint;
  initialBase: bigint;
  remainingBase: bigint;
  remainingOffer: bigint;
  feeReserve: bigint;
  costBudget: bigint;
  maxNetworkFee: bigint;
  maxRefundFee: bigint;
  refundAfter: bigint;
  minFill: bigint;
}

export interface DexV2MarketConfig {
  admin: Hex;
  treasury: Hex;
  base: Hex;
  quote: Hex;
  makerBps: number;
  takerBps: number;
  lotSize: bigint;
  minOrder: bigint;
  maxOrder: bigint;
  tickNum: bigint;
  tickDen: bigint;
  status: number;
}

export interface DexV2Fill {
  base: bigint;
  quote: bigint;
  payout: number;
  refund: number;
  successor: number;
  networkFee: bigint;
  treasuryCapacity: bigint;
}

export interface DexV2SettlementWitness {
  takerIndex: number;
  treasuryOutputIndex: number;
  fills: DexV2Fill[];
}

export interface DexV2RefundWitness {
  action: "CANCEL" | "REFUND";
  refundOutputIndex: number;
  networkFee: bigint;
}

// -----------------------------------------------------------------------------
// Buffer Utilities
// -----------------------------------------------------------------------------

function readU128LE(buf: Buffer, offset: number): bigint {
  const lo = buf.readBigUInt64LE(offset);
  const hi = buf.readBigUInt64LE(offset + 8);
  return (hi << 64n) | lo;
}

function writeU128LE(buf: Buffer, value: bigint, offset: number): void {
  if (value < 0n || value > 0xffff_ffff_ffff_ffff_ffff_ffff_ffff_ffffn) {
    throw new AppError(400, `value out of u128 range: ${value}`);
  }
  const lo = value & 0xffff_ffff_ffff_ffffn;
  const hi = (value >> 64n) & 0xffff_ffff_ffff_ffffn;
  buf.writeBigUInt64LE(lo, offset);
  buf.writeBigUInt64LE(hi, offset + 8);
}

function readU64LE(buf: Buffer, offset: number): bigint {
  return buf.readBigUInt64LE(offset);
}

function writeU64LE(buf: Buffer, value: bigint, offset: number): void {
  if (value < 0n || value > 0xffff_ffff_ffff_ffffn) {
    throw new AppError(400, `value out of u64 range: ${value}`);
  }
  buf.writeBigUInt64LE(value, offset);
}

export function ceilDiv(n: bigint, d: bigint): bigint {
  if (d === 0n) throw new AppError(400, "division by zero");
  return n / d + (n % d !== 0n ? 1n : 0n);
}

function normalizeInput(input: Hex | Uint8Array | Buffer): Buffer {
  if (typeof input === "string") return toBuffer(input);
  return Buffer.isBuffer(input) ? input : Buffer.from(input);
}

// -----------------------------------------------------------------------------
// Order Lock Args (243 bytes)
// -----------------------------------------------------------------------------

export function decodeDexV2Order(input: Hex | Uint8Array | Buffer): DexV2Order {
  const buf = normalizeInput(input);
  if (buf.length !== ORDER_ARGS_LEN) {
    throw new AppError(400, `invalid order args length: expected ${ORDER_ARGS_LEN}, got ${buf.length}`);
  }

  const version = buf.readUInt8(0);
  if (version !== DEX_V2_VERSION) {
    throw new AppError(400, `unsupported order args version: ${version}`);
  }

  const sideByte = buf.readUInt8(1);
  if (sideByte !== SIDE_BUY && sideByte !== SIDE_SELL) {
    throw new AppError(400, `invalid side byte: ${sideByte}`);
  }

  const kindByte = buf.readUInt8(2);
  if (kindByte !== KIND_LIMIT && kindByte !== KIND_MARKET) {
    throw new AppError(400, `invalid kind byte: ${kindByte}`);
  }

  let offset = 3;
  const owner = toHex(buf.subarray(offset, offset + 32));
  offset += 32;

  const market = toHex(buf.subarray(offset, offset + 32));
  offset += 32;

  const nonce = toHex(buf.subarray(offset, offset + 32));
  offset += 32;

  const priceNum = readU128LE(buf, offset);
  offset += 16;

  const priceDen = readU128LE(buf, offset);
  offset += 16;

  const initialBase = readU128LE(buf, offset);
  offset += 16;

  const remainingBase = readU128LE(buf, offset);
  offset += 16;

  const remainingOffer = readU128LE(buf, offset);
  offset += 16;

  const feeReserve = readU128LE(buf, offset);
  offset += 16;

  const costBudget = readU64LE(buf, offset);
  offset += 8;

  const maxNetworkFee = readU64LE(buf, offset);
  offset += 8;

  const maxRefundFee = readU64LE(buf, offset);
  offset += 8;

  const refundAfter = readU64LE(buf, offset);
  offset += 8;

  const minFill = readU128LE(buf, offset);
  offset += 16;

  return {
    side: sideByte === SIDE_BUY ? "BUY" : "SELL",
    kind: kindByte === KIND_LIMIT ? "LIMIT" : "MARKET",
    owner,
    market,
    nonce,
    priceNum,
    priceDen,
    initialBase,
    remainingBase,
    remainingOffer,
    feeReserve,
    costBudget,
    maxNetworkFee,
    maxRefundFee,
    refundAfter,
    minFill,
  };
}

export function encodeDexV2Order(order: DexV2Order): Hex {
  const buf = Buffer.alloc(ORDER_ARGS_LEN);
  buf.writeUInt8(DEX_V2_VERSION, 0);
  buf.writeUInt8(order.side === "BUY" ? SIDE_BUY : SIDE_SELL, 1);
  buf.writeUInt8(order.kind === "LIMIT" ? KIND_LIMIT : KIND_MARKET, 2);

  let offset = 3;
  toBuffer(order.owner).copy(buf, offset);
  offset += 32;

  toBuffer(order.market).copy(buf, offset);
  offset += 32;

  toBuffer(order.nonce).copy(buf, offset);
  offset += 32;

  writeU128LE(buf, order.priceNum, offset);
  offset += 16;

  writeU128LE(buf, order.priceDen, offset);
  offset += 16;

  writeU128LE(buf, order.initialBase, offset);
  offset += 16;

  writeU128LE(buf, order.remainingBase, offset);
  offset += 16;

  writeU128LE(buf, order.remainingOffer, offset);
  offset += 16;

  writeU128LE(buf, order.feeReserve, offset);
  offset += 16;

  writeU64LE(buf, order.costBudget, offset);
  offset += 8;

  writeU64LE(buf, order.maxNetworkFee, offset);
  offset += 8;

  writeU64LE(buf, order.maxRefundFee, offset);
  offset += 8;

  writeU64LE(buf, order.refundAfter, offset);
  offset += 8;

  writeU128LE(buf, order.minFill, offset);
  offset += 16;

  return toHex(buf);
}

export function validateDexV2Order(order: DexV2Order, market: DexV2MarketConfig): void {
  if (
    order.owner === NATIVE_ASSET_HASH ||
    order.nonce === NATIVE_ASSET_HASH ||
    order.initialBase === 0n ||
    order.remainingBase === 0n ||
    order.remainingBase > order.initialBase ||
    order.remainingOffer === 0n ||
    order.priceNum === 0n ||
    order.priceDen !== market.tickDen ||
    order.priceNum % market.tickNum !== 0n ||
    order.initialBase < market.minOrder ||
    order.initialBase > market.maxOrder ||
    order.initialBase % market.lotSize !== 0n ||
    order.remainingBase % market.lotSize !== 0n ||
    order.minFill === 0n ||
    order.minFill > order.initialBase ||
    order.minFill % market.lotSize !== 0n ||
    order.maxRefundFee > order.maxNetworkFee ||
    order.refundAfter >= 1n << 56n ||
    (order.kind === "MARKET" && order.refundAfter === 0n)
  ) {
    throw new AppError(400, "order violates v2 state rules");
  }

  if (order.side === "SELL") {
    if (order.remainingOffer !== order.remainingBase || order.feeReserve !== 0n) {
      throw new AppError(400, "sell order must offer remaining base with zero fee reserve");
    }
  }

  if (order.side === "BUY") {
    if (order.kind === "LIMIT") {
      const requiredQuote = ceilDiv(order.remainingBase * order.priceNum, order.priceDen);
      if (order.remainingOffer < requiredQuote) {
        throw new AppError(400, `buy order offered quote ${order.remainingOffer} < required ${requiredQuote}`);
      }
    }
    const worstRate = BigInt(Math.max(market.makerBps, market.takerBps));
    const requiredReserve = ceilDiv(order.remainingOffer * worstRate, BPS);
    if (order.feeReserve < requiredReserve) {
      throw new AppError(400, `buy fee reserve ${order.feeReserve} < required ${requiredReserve}`);
    }
  }
}

export function calcOrderEscrow(order: DexV2Order): bigint {
  return order.remainingOffer + order.feeReserve;
}

export function getOfferedAsset(order: DexV2Order, market: DexV2MarketConfig): Hex {
  return order.side === "BUY" ? market.quote : market.base;
}

export function getReceivedAsset(order: DexV2Order, market: DexV2MarketConfig): Hex {
  return order.side === "BUY" ? market.base : market.quote;
}

// -----------------------------------------------------------------------------
// Market Config Data (214 bytes)
// -----------------------------------------------------------------------------

export function decodeDexV2MarketConfig(input: Hex | Uint8Array | Buffer): DexV2MarketConfig {
  const buf = normalizeInput(input);
  if (buf.length !== MARKET_CONFIG_LEN) {
    throw new AppError(400, `invalid market config length: expected ${MARKET_CONFIG_LEN}, got ${buf.length}`);
  }

  const version = buf.readUInt8(0);
  if (version !== DEX_V2_VERSION) {
    throw new AppError(400, `unsupported market config version: ${version}`);
  }

  let offset = 1;
  const admin = toHex(buf.subarray(offset, offset + 32));
  offset += 32;

  const treasury = toHex(buf.subarray(offset, offset + 32));
  offset += 32;

  const base = toHex(buf.subarray(offset, offset + 32));
  offset += 32;

  const quote = toHex(buf.subarray(offset, offset + 32));
  offset += 32;

  const makerBps = buf.readUInt16LE(offset);
  offset += 2;

  const takerBps = buf.readUInt16LE(offset);
  offset += 2;

  const lotSize = readU128LE(buf, offset);
  offset += 16;

  const minOrder = readU128LE(buf, offset);
  offset += 16;

  const maxOrder = readU128LE(buf, offset);
  offset += 16;

  const tickNum = readU128LE(buf, offset);
  offset += 16;

  const tickDen = readU128LE(buf, offset);
  offset += 16;

  const status = buf.readUInt8(offset);

  if (
    admin === NATIVE_ASSET_HASH ||
    treasury === NATIVE_ASSET_HASH ||
    base === quote ||
    makerBps > 10_000 ||
    takerBps > 10_000 ||
    lotSize === 0n ||
    minOrder === 0n ||
    maxOrder < minOrder ||
    minOrder % lotSize !== 0n ||
    maxOrder % lotSize !== 0n ||
    tickNum === 0n ||
    tickDen === 0n ||
    status > 2
  ) {
    throw new AppError(400, "invalid market configuration parameters");
  }

  return {
    admin,
    treasury,
    base,
    quote,
    makerBps,
    takerBps,
    lotSize,
    minOrder,
    maxOrder,
    tickNum,
    tickDen,
    status,
  };
}

export function encodeDexV2MarketConfig(config: DexV2MarketConfig): Hex {
  const buf = Buffer.alloc(MARKET_CONFIG_LEN);
  buf.writeUInt8(DEX_V2_VERSION, 0);

  let offset = 1;
  toBuffer(config.admin).copy(buf, offset);
  offset += 32;

  toBuffer(config.treasury).copy(buf, offset);
  offset += 32;

  toBuffer(config.base).copy(buf, offset);
  offset += 32;

  toBuffer(config.quote).copy(buf, offset);
  offset += 32;

  buf.writeUInt16LE(config.makerBps, offset);
  offset += 2;

  buf.writeUInt16LE(config.takerBps, offset);
  offset += 2;

  writeU128LE(buf, config.lotSize, offset);
  offset += 16;

  writeU128LE(buf, config.minOrder, offset);
  offset += 16;

  writeU128LE(buf, config.maxOrder, offset);
  offset += 16;

  writeU128LE(buf, config.tickNum, offset);
  offset += 16;

  writeU128LE(buf, config.tickDen, offset);
  offset += 16;

  buf.writeUInt8(config.status, offset);

  return toHex(buf);
}

// -----------------------------------------------------------------------------
// Witness Encoders and Decoders
// -----------------------------------------------------------------------------

export function encodeDexV2SettlementWitness(witness: DexV2SettlementWitness): Hex {
  const n = witness.fills.length;
  if (n < 2 || n > MAX_ORDERS) {
    throw new AppError(400, `order count must be between 2 and ${MAX_ORDERS}, got ${n}`);
  }
  if (witness.takerIndex >= n) {
    throw new AppError(400, `taker index ${witness.takerIndex} out of bounds (${n})`);
  }

  // Header: version(1) + action(1) + n(1) + taker(1) + treasury_output(4) = 8 bytes
  // Each fill: base(16) + quote(16) + payout(4) + refund(4) + successor(4) + net_fee(8) + treas_cap(8) = 60 bytes
  const buf = Buffer.alloc(8 + n * 60);
  buf.writeUInt8(DEX_V2_VERSION, 0);
  buf.writeUInt8(ACTION_SETTLEMENT, 1);
  buf.writeUInt8(n, 2);
  buf.writeUInt8(witness.takerIndex, 3);
  buf.writeUInt32LE(witness.treasuryOutputIndex, 4);

  let offset = 8;
  for (const fill of witness.fills) {
    writeU128LE(buf, fill.base, offset);
    offset += 16;

    writeU128LE(buf, fill.quote, offset);
    offset += 16;

    buf.writeUInt32LE(fill.payout, offset);
    offset += 4;

    buf.writeUInt32LE(fill.refund, offset);
    offset += 4;

    buf.writeUInt32LE(fill.successor, offset);
    offset += 4;

    writeU64LE(buf, fill.networkFee, offset);
    offset += 8;

    writeU64LE(buf, fill.treasuryCapacity, offset);
    offset += 8;
  }

  return toHex(buf);
}

export function decodeDexV2SettlementWitness(input: Hex | Uint8Array | Buffer): DexV2SettlementWitness {
  const buf = normalizeInput(input);
  if (buf.length < 8) {
    throw new AppError(400, `settlement witness truncated: ${buf.length} bytes`);
  }

  const version = buf.readUInt8(0);
  if (version !== DEX_V2_VERSION) {
    throw new AppError(400, `unsupported witness version ${version}`);
  }

  const action = buf.readUInt8(1);
  if (action !== ACTION_SETTLEMENT) {
    throw new AppError(400, `expected settlement action 0, got ${action}`);
  }

  const n = buf.readUInt8(2);
  if (n < 2 || n > MAX_ORDERS) {
    throw new AppError(400, `invalid order count in witness: ${n}`);
  }

  const expectedLen = 8 + n * 60;
  if (buf.length !== expectedLen) {
    throw new AppError(400, `witness length mismatch: expected ${expectedLen}, got ${buf.length}`);
  }

  const takerIndex = buf.readUInt8(3);
  const treasuryOutputIndex = buf.readUInt32LE(4);

  let offset = 8;
  const fills: DexV2Fill[] = [];
  for (let i = 0; i < n; i++) {
    const base = readU128LE(buf, offset);
    offset += 16;

    const quote = readU128LE(buf, offset);
    offset += 16;

    const payout = buf.readUInt32LE(offset);
    offset += 4;

    const refund = buf.readUInt32LE(offset);
    offset += 4;

    const successor = buf.readUInt32LE(offset);
    offset += 4;

    const networkFee = readU64LE(buf, offset);
    offset += 8;

    const treasuryCapacity = readU64LE(buf, offset);
    offset += 8;

    fills.push({
      base,
      quote,
      payout,
      refund,
      successor,
      networkFee,
      treasuryCapacity,
    });
  }

  return {
    takerIndex,
    treasuryOutputIndex,
    fills,
  };
}

export function encodeDexV2RefundWitness(witness: DexV2RefundWitness): Hex {
  // 14 bytes: version(1) + action(1) + refund_output_index(4) + network_fee(8)
  const buf = Buffer.alloc(14);
  buf.writeUInt8(DEX_V2_VERSION, 0);
  buf.writeUInt8(witness.action === "CANCEL" ? ACTION_CANCEL : ACTION_REFUND, 1);
  buf.writeUInt32LE(witness.refundOutputIndex, 2);
  writeU64LE(buf, witness.networkFee, 6);
  return toHex(buf);
}

export function decodeDexV2RefundWitness(input: Hex | Uint8Array | Buffer): DexV2RefundWitness {
  const buf = normalizeInput(input);
  if (buf.length !== 14) {
    throw new AppError(400, `invalid refund witness length: expected 14, got ${buf.length}`);
  }

  const version = buf.readUInt8(0);
  if (version !== DEX_V2_VERSION) {
    throw new AppError(400, `unsupported refund witness version ${version}`);
  }

  const actionByte = buf.readUInt8(1);
  if (actionByte !== ACTION_CANCEL && actionByte !== ACTION_REFUND) {
    throw new AppError(400, `unknown refund action ${actionByte}`);
  }

  const refundOutputIndex = buf.readUInt32LE(2);
  const networkFee = readU64LE(buf, 6);

  return {
    action: actionByte === ACTION_CANCEL ? "CANCEL" : "REFUND",
    refundOutputIndex,
    networkFee,
  };
}
