// Populates the numeric sort keys on documents written before they existed.
import { getDeployment } from "../../../shared/deployment.mjs";
import OrderModel, { OrderStatus } from "../models/order.js";
import TradeModel from "../models/trade.js";

export async function backfillSortKeys(): Promise<{ orders: number; trades: number }> {
  const orders = await OrderModel.updateMany(
    { $or: [{ priceValue: { $exists: false } }, { blockNum: { $exists: false } }, { txIdx: { $exists: false } }] },
    [{
      $set: {
        priceValue: { $convert: { input: "$pricePerToken", to: "decimal", onError: null, onNull: null } },
        blockNum: { $convert: { input: "$blockNumber", to: "long", onError: null, onNull: null } },
        txIdx: { $convert: { input: "$txIndex", to: "long", onError: null, onNull: null } },
      },
    }],
    { updatePipeline: true },
  );
  const trades = await TradeModel.updateMany(
    { blockNum: { $exists: false } },
    [{ $set: { blockNum: { $convert: { input: "$blockNumber", to: "long", onError: null, onNull: null } } } }],
    { updatePipeline: true },
  );
  return { orders: orders.modifiedCount, trades: trades.modifiedCount };
}

const ACTIVE_STATUSES: OrderStatus[] = ["DISCOVERED", "LIVE", "RESERVED", "PENDING", "SETTLEMENT_SUBMITTED"];

/** Marks open orders from retired DEX script or market config hashes as INVALID so they leave the orderbook. */
export async function cleanupObsoleteOrders(config: {
  dexOrderLockScript: { codeHash: string };
  ckbNetwork: string;
}): Promise<number> {
  const staleConditions: Record<string, unknown>[] = [
    { "lockScript.codeHash": { $ne: config.dexOrderLockScript.codeHash } },
  ];

  try {
    const deployment = getDeployment(config.ckbNetwork);
    if (deployment?.market?.marketHash) {
      staleConditions.push(
        { marketConfigHash: { $exists: false } },
        { marketConfigHash: { $ne: deployment.market.marketHash } },
      );
    }
  } catch {
    // No manifest for network; fall back to codeHash check only.
  }

  const res = await OrderModel.updateMany(
    { status: { $in: ACTIVE_STATUSES }, $or: staleConditions },
    { $set: { status: "INVALID", reservedUntil: null, pendingTxHash: null } },
  );
  return res.modifiedCount;
}
