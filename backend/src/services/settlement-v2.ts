// Settlement Transaction Builder for CKB DEX V2 smart contracts.
// Reference: smart-contract/contracts/dex-order-lock-v2/src/main.rs and crates/dex-v2-core/src/lib.rs

import { ccc } from "@ckb-ccc/core";
import {
  DexV2Order,
  DexV2MarketConfig,
  DexV2Fill,
  encodeDexV2Order,
  encodeDexV2SettlementWitness,
  ceilDiv,
  INDEX_NONE,
  NATIVE_ASSET_HASH,
  BPS,
} from "../utils/dex-v2-codec.js";
import { Hex, Script } from "../types/index.js";
import AppError from "./error.js";
import { toBuffer, toHex } from "../utils/shared.js";

export interface SettlementInputOrder {
  order: DexV2Order;
  outPoint: { txHash: string; index: number };
  cellCapacity: bigint;
  ownerLock: ccc.ScriptLike;
  typeScript?: ccc.ScriptLike;
  cellData: Hex;
}

export interface BuildSettlementParams {
  orders: SettlementInputOrder[];
  takerIndex: number;
  market: DexV2MarketConfig;
  treasuryLock: ccc.ScriptLike;
  dexOrderLockCellDep: ccc.CellDepLike;
  marketConfigCellDep: ccc.CellDepLike;
  xudtCellDeps: ccc.CellDepLike[];
  networkFeeRate?: bigint;
}

export interface BuiltSettlement {
  tx: ccc.Transaction;
  fills: DexV2Fill[];
  treasuryOutputIndex: number;
  totalFees: bigint;
}

const MIN_CELL_CAPACITY = 61_0000_0000n; // 61 CKB standard minimum occupied capacity for empty cell
const DEFAULT_FEE_SHARE = 100_000n; // 0.001 CKB default network fee share per order

/**
 * Builds a canonical V2 settlement transaction between orders (e.g. 1 BUY and 1 SELL, or batch).
 */
export function buildV2Settlement(params: BuildSettlementParams): BuiltSettlement {
  const { orders, takerIndex, market } = params;
  const treasuryLock = ccc.Script.from(params.treasuryLock);
  if (treasuryLock.hash() !== market.treasury) {
    throw new AppError(400, "Treasury lock script does not match the market configuration");
  }
  const n = orders.length;

  if (n < 2) {
    throw new AppError(400, "settlement requires at least 2 orders");
  }
  if (takerIndex >= n) {
    throw new AppError(400, `invalid taker index: ${takerIndex}`);
  }

  const taker = orders[takerIndex];
  const makerIndex = takerIndex === 0 ? 1 : 0;
  const maker = orders[makerIndex];

  if (taker.order.side === maker.order.side) {
    throw new AppError(400, "taker and maker cannot be on the same side");
  }

  // Determine fill base amount
  const fillBase = taker.order.remainingBase < maker.order.remainingBase
    ? taker.order.remainingBase
    : maker.order.remainingBase;

  if (fillBase <= 0n) {
    throw new AppError(400, "fill base quantity must be positive");
  }

  // Maker sets execution price in order book crossing
  // If maker is SELL: quote = ceil(fillBase * maker.priceNum / maker.priceDen)
  // If maker is BUY:  quote = fillBase * maker.priceNum / maker.priceDen
  const fillQuote = maker.order.side === "SELL"
    ? ceilDiv(fillBase * maker.order.priceNum, maker.order.priceDen)
    : (fillBase * maker.order.priceNum) / maker.order.priceDen;

  // Calculate fees
  const makerFeeRate = BigInt(market.makerBps);
  const takerFeeRate = BigInt(market.takerBps);

  const makerFee = (fillQuote * makerFeeRate) / BPS;
  const takerFee = (fillQuote * takerFeeRate) / BPS;
  const totalFees = makerFee + takerFee;

  const isQuoteNative = market.quote === NATIVE_ASSET_HASH;

  // Treasury storage calculation
  // For native CKB: top-up is max(0, occupied - fees)
  // For UDT: top-up is minimum cell capacity
  const treasuryType = isQuoteNative ? undefined : orders
    .map((order) => order.typeScript)
    .find((type) => type && ccc.Script.from(type).hash() === market.quote);
  if (!isQuoteNative && totalFees > 0n && !treasuryType) {
    throw new AppError(400, "Missing quote asset type script for treasury payment");
  }
  const treasuryData = isQuoteNative ? "0x" : ccc.hexFrom(ccc.numLeToBytes(totalFees, 16));
  const treasuryOccupied = ccc.CellOutput.from({ lock: treasuryLock, type: treasuryType }, treasuryData).capacity;
  const nativeFees = isQuoteNative ? totalFees : 0n;
  const treasuryStorageTopUp = totalFees > 0n
    ? (treasuryOccupied > nativeFees ? treasuryOccupied - nativeFees : 0n)
    : 0n;

  // Storage share split: equal shares, remainder to taker
  const baseStorageShare = treasuryStorageTopUp / BigInt(n);
  const remainderStorageShare = treasuryStorageTopUp % BigInt(n);

  const fills: DexV2Fill[] = [];
  const outputs: ccc.CellOutputLike[] = [];
  const outputsData: Hex[] = [];

  // Helper to add an output
  const addOutput = (lock: ccc.ScriptLike, capacity: bigint, type?: ccc.ScriptLike, data: Hex = "0x"): number => {
    const idx = outputs.length;
    outputs.push({
      lock,
      capacity,
      type,
    });
    outputsData.push(data);
    return idx;
  };

  // 1. Payouts for orders
  for (let i = 0; i < n; i++) {
    const isTaker = i === takerIndex;
    const ord = orders[i].order;
    const inputOrder = orders[i];

    const fee = isTaker ? takerFee : makerFee;
    const storageShare = baseStorageShare + (isTaker ? remainderStorageShare : 0n);
    const networkFee = ord.maxNetworkFee < DEFAULT_FEE_SHARE ? ord.maxNetworkFee : DEFAULT_FEE_SHARE;

    let payoutIdx = INDEX_NONE;
    let successorIdx = INDEX_NONE;
    let refundIdx = INDEX_NONE;

    if (ord.side === "BUY") {
      // Buyer receives base tokens (UDT)
      const udtAmountLe = Buffer.alloc(16);
      const lo = fillBase & 0xffff_ffff_ffff_ffffn;
      const hi = (fillBase >> 64n) & 0xffff_ffff_ffff_ffffn;
      udtAmountLe.writeBigUInt64LE(lo, 0);
      udtAmountLe.writeBigUInt64LE(hi, 8);

      // Payout cell for base token
      const tokenCellCapacity = MIN_CELL_CAPACITY;
      payoutIdx = addOutput(
        inputOrder.ownerLock,
        tokenCellCapacity,
        inputOrder.typeScript, // Base UDT type script
        toHex(udtAmountLe),
      );

      // Check if partial fill -> Successor order
      const remainingBase = ord.remainingBase - fillBase;
      const remainingOffer = ord.remainingOffer - fillQuote;
      const remainingFeeReserve = ord.feeReserve > fee ? ord.feeReserve - fee : 0n;
      const cost = networkFee + storageShare;
      if (ord.costBudget < cost) {
        throw new AppError(400, `order cost budget ${ord.costBudget} is insufficient for required cost ${cost}`);
      }
      const remainingCost = ord.costBudget - cost;

      if (remainingBase > 0n && ord.kind === "LIMIT") {
        const nextOrder: DexV2Order = {
          ...ord,
          remainingBase,
          remainingOffer,
          feeReserve: remainingFeeReserve,
          costBudget: remainingCost,
        };
        const nextArgs = encodeDexV2Order(nextOrder);
        const successorCapacity = MIN_CELL_CAPACITY + (isQuoteNative ? (remainingOffer + remainingFeeReserve) : 0n);
        successorIdx = addOutput(
          {
            codeHash: inputOrder.ownerLock.codeHash, // dex lock
            hashType: inputOrder.ownerLock.hashType,
            args: nextArgs,
          },
          successorCapacity,
          !isQuoteNative ? inputOrder.typeScript : undefined,
          "0x",
        );
      }
    } else {
      // Seller receives quote asset (net of seller fee)
      const netQuoteReceived = fillQuote - fee;

      if (isQuoteNative) {
        // Native CKB received
        payoutIdx = addOutput(
          inputOrder.ownerLock,
          inputOrder.cellCapacity + netQuoteReceived - (networkFee + storageShare),
          undefined,
          "0x",
        );
      } else {
        // UDT quote received
        const udtAmountLe = Buffer.alloc(16);
        const lo = netQuoteReceived & 0xffff_ffff_ffff_ffffn;
        const hi = (netQuoteReceived >> 64n) & 0xffff_ffff_ffff_ffffn;
        udtAmountLe.writeBigUInt64LE(lo, 0);
        udtAmountLe.writeBigUInt64LE(hi, 8);

        payoutIdx = addOutput(
          inputOrder.ownerLock,
          MIN_CELL_CAPACITY,
          inputOrder.typeScript,
          toHex(udtAmountLe),
        );
      }

      // Check if partial fill -> Successor order
      const remainingBase = ord.remainingBase - fillBase;
      const remainingOffer = remainingBase;
      const cost = networkFee + storageShare;
      if (ord.costBudget < cost) {
        throw new AppError(400, `order cost budget ${ord.costBudget} is insufficient for required cost ${cost}`);
      }
      const remainingCost = ord.costBudget - cost;

      if (remainingBase > 0n && ord.kind === "LIMIT") {
        const nextOrder: DexV2Order = {
          ...ord,
          remainingBase,
          remainingOffer,
          costBudget: remainingCost,
        };
        const nextArgs = encodeDexV2Order(nextOrder);

        const udtData = Buffer.alloc(16);
        udtData.writeBigUInt64LE(remainingOffer & 0xffff_ffff_ffff_ffffn, 0);
        udtData.writeBigUInt64LE((remainingOffer >> 64n) & 0xffff_ffff_ffff_ffffn, 8);

        successorIdx = addOutput(
          {
            codeHash: inputOrder.ownerLock.codeHash,
            hashType: inputOrder.ownerLock.hashType,
            args: nextArgs,
          },
          MIN_CELL_CAPACITY,
          inputOrder.typeScript,
          toHex(udtData),
        );
      }
    }

    fills.push({
      base: fillBase,
      quote: fillQuote,
      payout: payoutIdx,
      refund: refundIdx,
      successor: successorIdx,
      networkFee,
      treasuryCapacity: storageShare,
    });
  }

  // 2. Treasury output
  let treasuryOutputIndex = INDEX_NONE;
  if (totalFees > 0n) {
    if (isQuoteNative) {
      treasuryOutputIndex = addOutput(
        treasuryLock,
        treasuryStorageTopUp + totalFees,
        undefined,
        "0x",
      );
    } else {
      const feeData = Buffer.alloc(16);
      feeData.writeBigUInt64LE(totalFees & 0xffff_ffff_ffff_ffffn, 0);
      feeData.writeBigUInt64LE((totalFees >> 64n) & 0xffff_ffff_ffff_ffffn, 8);

      treasuryOutputIndex = addOutput(
        treasuryLock,
        treasuryOccupied,
        treasuryType,
        toHex(feeData),
      );
    }
  }

  // 3. Assemble inputs
  const inputs: ccc.CellInputLike[] = orders.map((o) => ({
    previousOutput: {
      txHash: o.outPoint.txHash,
      index: o.outPoint.index,
    },
    since: 0,
  }));

  // 4. Build witness payload in WitnessArgs.lock
  const settlementWitness = encodeDexV2SettlementWitness({
    takerIndex,
    treasuryOutputIndex,
    fills,
  });

  const tx = ccc.Transaction.from({
    inputs,
    outputs,
    outputsData,
  });

  // Cell deps: DEX order lock, Market Config, and xUDT
  tx.addCellDeps([params.dexOrderLockCellDep, params.marketConfigCellDep, ...params.xudtCellDeps]);

  // Set witness for input 0
  tx.witnesses = [
    ccc.hexFrom(
      ccc.WitnessArgs.from({
        lock: settlementWitness,
      }).toBytes(),
    ),
  ];

  return {
    tx,
    fills,
    treasuryOutputIndex,
    totalFees,
  };
}
