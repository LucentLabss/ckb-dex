// Pure JavaScript ES module codec for CKB DEX V2 smart contracts.
// Runs natively in both browser (Vite) and Node.js with zero dependencies.
// Reference: smart-contract/crates/dex-v2-core/src/lib.rs

export const DEX_V2_VERSION = 2;
export const ORDER_ARGS_LEN = 243;
export const MARKET_CONFIG_LEN = 214;
export const INDEX_NONE = 0xffff_ffff;
export const MAX_ORDERS = 16;
export const BPS = 10_000n;
export const NATIVE_ASSET_HASH = "0x0000000000000000000000000000000000000000000000000000000000000000";

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

export function ceilDiv(n, d) {
  if (d === 0n) throw new Error("division by zero");
  return n / d + (n % d !== 0n ? 1n : 0n);
}

export function bytesFromHex(hex) {
  if (typeof hex !== "string") throw new Error("Expected hex string");
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error(`Invalid hex string length: ${clean.length}`);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function hexFromBytes(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let hex = "0x";
  for (let i = 0; i < arr.length; i++) {
    hex += arr[i].toString(16).padStart(2, "0");
  }
  return hex;
}

function toBytes(input) {
  if (typeof input === "string") return bytesFromHex(input);
  if (input instanceof Uint8Array) return input;
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  throw new Error("Unsupported binary input");
}

function writeU128LE(view, value, offset) {
  const bi = BigInt(value);
  if (bi < 0n || bi > 0xffff_ffff_ffff_ffff_ffff_ffff_ffff_ffffn) {
    throw new Error(`value out of u128 range: ${value}`);
  }
  const low = bi & 0xffff_ffff_ffff_ffffn;
  const high = (bi >> 64n) & 0xffff_ffff_ffff_ffffn;
  view.setBigUint64(offset, low, true);
  view.setBigUint64(offset + 8, high, true);
}

function readU128LE(view, offset) {
  const low = view.getBigUint64(offset, true);
  const high = view.getBigUint64(offset + 8, true);
  return low + (high << 64n);
}

function writeU64LE(view, value, offset) {
  const bi = BigInt(value);
  if (bi < 0n || bi > 0xffff_ffff_ffff_ffffn) {
    throw new Error(`value out of u64 range: ${value}`);
  }
  view.setBigUint64(offset, bi, true);
}

function readU64LE(view, offset) {
  return view.getBigUint64(offset, true);
}

// -----------------------------------------------------------------------------
// Order Lock Args (243 bytes)
// -----------------------------------------------------------------------------

export function decodeDexV2Order(input) {
  const bytes = toBytes(input);
  if (bytes.length !== ORDER_ARGS_LEN) {
    throw new Error(`invalid order args length: expected ${ORDER_ARGS_LEN}, got ${bytes.length}`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const version = bytes[0];
  if (version !== DEX_V2_VERSION) {
    throw new Error(`unsupported order args version: ${version}`);
  }

  const sideByte = bytes[1];
  if (sideByte !== SIDE_BUY && sideByte !== SIDE_SELL) {
    throw new Error(`invalid side byte: ${sideByte}`);
  }

  const kindByte = bytes[2];
  if (kindByte !== KIND_LIMIT && kindByte !== KIND_MARKET) {
    throw new Error(`invalid kind byte: ${kindByte}`);
  }

  let offset = 3;
  const owner = hexFromBytes(bytes.subarray(offset, offset + 32));
  offset += 32;

  const market = hexFromBytes(bytes.subarray(offset, offset + 32));
  offset += 32;

  const nonce = hexFromBytes(bytes.subarray(offset, offset + 32));
  offset += 32;

  const priceNum = readU128LE(view, offset);
  offset += 16;

  const priceDen = readU128LE(view, offset);
  offset += 16;

  const initialBase = readU128LE(view, offset);
  offset += 16;

  const remainingBase = readU128LE(view, offset);
  offset += 16;

  const remainingOffer = readU128LE(view, offset);
  offset += 16;

  const feeReserve = readU128LE(view, offset);
  offset += 16;

  const costBudget = readU64LE(view, offset);
  offset += 8;

  const maxNetworkFee = readU64LE(view, offset);
  offset += 8;

  const maxRefundFee = readU64LE(view, offset);
  offset += 8;

  const refundAfter = readU64LE(view, offset);
  offset += 8;

  const minFill = readU128LE(view, offset);
  offset += 16;

  if (priceNum === 0n || priceDen === 0n) {
    throw new Error("price numerator and denominator must be non-zero");
  }
  if (initialBase === 0n || remainingBase === 0n || remainingBase > initialBase) {
    throw new Error("invalid base amounts");
  }
  if (remainingOffer === 0n) {
    throw new Error("remaining offer must be non-zero");
  }
  if (minFill === 0n || minFill > remainingBase) {
    throw new Error("minFill must be non-zero and <= remainingBase");
  }

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

export function encodeDexV2Order(order) {
  const bytes = new Uint8Array(ORDER_ARGS_LEN);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  bytes[0] = DEX_V2_VERSION;
  bytes[1] = order.side === "BUY" ? SIDE_BUY : SIDE_SELL;
  bytes[2] = order.kind === "LIMIT" ? KIND_LIMIT : KIND_MARKET;

  let offset = 3;
  bytes.set(bytesFromHex(order.owner), offset);
  offset += 32;

  bytes.set(bytesFromHex(order.market), offset);
  offset += 32;

  bytes.set(bytesFromHex(order.nonce), offset);
  offset += 32;

  writeU128LE(view, order.priceNum, offset);
  offset += 16;

  writeU128LE(view, order.priceDen, offset);
  offset += 16;

  writeU128LE(view, order.initialBase, offset);
  offset += 16;

  writeU128LE(view, order.remainingBase, offset);
  offset += 16;

  writeU128LE(view, order.remainingOffer, offset);
  offset += 16;

  writeU128LE(view, order.feeReserve, offset);
  offset += 16;

  writeU64LE(view, order.costBudget, offset);
  offset += 8;

  writeU64LE(view, order.maxNetworkFee, offset);
  offset += 8;

  writeU64LE(view, order.maxRefundFee, offset);
  offset += 8;

  writeU64LE(view, order.refundAfter, offset);
  offset += 8;

  writeU128LE(view, order.minFill, offset);
  offset += 16;

  return hexFromBytes(bytes);
}

// -----------------------------------------------------------------------------
// Market Configuration (214 bytes)
// -----------------------------------------------------------------------------

export function decodeDexV2MarketConfig(input) {
  const bytes = toBytes(input);
  if (bytes.length !== MARKET_CONFIG_LEN) {
    throw new Error(`invalid market config length: expected ${MARKET_CONFIG_LEN}, got ${bytes.length}`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  if (bytes[0] !== DEX_V2_VERSION) {
    throw new Error(`unsupported market config version: ${bytes[0]}`);
  }

  let offset = 1;
  const admin = hexFromBytes(bytes.subarray(offset, offset + 32));
  offset += 32;

  const treasury = hexFromBytes(bytes.subarray(offset, offset + 32));
  offset += 32;

  const base = hexFromBytes(bytes.subarray(offset, offset + 32));
  offset += 32;

  const quote = hexFromBytes(bytes.subarray(offset, offset + 32));
  offset += 32;

  const makerBps = view.getUint16(offset, true);
  offset += 2;

  const takerBps = view.getUint16(offset, true);
  offset += 2;

  const lotSize = readU128LE(view, offset);
  offset += 16;

  const minOrder = readU128LE(view, offset);
  offset += 16;

  const maxOrder = readU128LE(view, offset);
  offset += 16;

  const tickNum = readU128LE(view, offset);
  offset += 16;

  const tickDen = readU128LE(view, offset);
  offset += 16;

  const status = bytes[offset];

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
    throw new Error("invalid market configuration parameters");
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

export function encodeDexV2MarketConfig(config) {
  const bytes = new Uint8Array(MARKET_CONFIG_LEN);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  bytes[0] = DEX_V2_VERSION;

  let offset = 1;
  bytes.set(bytesFromHex(config.admin), offset);
  offset += 32;

  bytes.set(bytesFromHex(config.treasury), offset);
  offset += 32;

  bytes.set(bytesFromHex(config.base), offset);
  offset += 32;

  bytes.set(bytesFromHex(config.quote), offset);
  offset += 32;

  view.setUint16(offset, config.makerBps, true);
  offset += 2;

  view.setUint16(offset, config.takerBps, true);
  offset += 2;

  writeU128LE(view, config.lotSize, offset);
  offset += 16;

  writeU128LE(view, config.minOrder, offset);
  offset += 16;

  writeU128LE(view, config.maxOrder, offset);
  offset += 16;

  writeU128LE(view, config.tickNum, offset);
  offset += 16;

  writeU128LE(view, config.tickDen, offset);
  offset += 16;

  bytes[offset] = config.status;

  return hexFromBytes(bytes);
}

// -----------------------------------------------------------------------------
// Witness Encoders and Decoders
// -----------------------------------------------------------------------------

export function encodeDexV2RefundWitness(witness) {
  // 14 bytes: version(1) + action(1) + refund_output_index(4) + network_fee(8)
  const bytes = new Uint8Array(14);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  bytes[0] = DEX_V2_VERSION;
  bytes[1] = witness.action === "CANCEL" ? ACTION_CANCEL : ACTION_REFUND;
  view.setUint32(2, witness.refundOutputIndex, true);
  writeU64LE(view, witness.refundFee, 6);

  return hexFromBytes(bytes);
}

export function decodeDexV2RefundWitness(input) {
  const bytes = toBytes(input);
  if (bytes.length !== 14) {
    throw new Error(`invalid refund witness length: expected 14, got ${bytes.length}`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  if (bytes[0] !== DEX_V2_VERSION) {
    throw new Error(`unsupported refund witness version: ${bytes[0]}`);
  }

  const actionByte = bytes[1];
  if (actionByte !== ACTION_CANCEL && actionByte !== ACTION_REFUND) {
    throw new Error(`invalid refund action byte: ${actionByte}`);
  }

  const refundOutputIndex = view.getUint32(2, true);
  const refundFee = readU64LE(view, 6);

  return {
    action: actionByte === ACTION_CANCEL ? "CANCEL" : "REFUND",
    refundOutputIndex,
    refundFee,
  };
}
