// Populates the numeric sort keys on documents written before they existed.
import OrderModel from "../models/order.js";
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
