// Defines the immutable MongoDB projection for a confirmed settlement trade.
import mongoose, { Schema } from "mongoose";

export interface TradeDocument {
  _id: string;
  settlementTxHash: string;
  buyOrderOutPoint: {
    txHash: string;
    index: string;
  };
  sellOrderOutPoint: {
    txHash: string;
    index: string;
  };
  buyerLockHash: string;
  sellerLockHash: string;
  xudtTypeHash: string;
  tokenAmount: string;
  price: string;
  paidCapacity: string;
  blockNumber: string;
  blockHash: string;
  confirmedAtBlock: string;
  lastEventId: string;
  createdAt: Date;
  updatedAt: Date;
}

const OutPointSchema = new Schema(
  {
    txHash: { type: String, required: true, immutable: true },
    index: { type: String, required: true, immutable: true },
  },
  { _id: false },
);

export const TradeSchema = new Schema<TradeDocument>(
  {
    _id: { type: String, required: true, immutable: true },
    settlementTxHash: { type: String, required: true, immutable: true },
    buyOrderOutPoint: { type: OutPointSchema, required: true, immutable: true },
    sellOrderOutPoint: { type: OutPointSchema, required: true, immutable: true },
    buyerLockHash: { type: String, required: true, immutable: true },
    sellerLockHash: { type: String, required: true, immutable: true },
    xudtTypeHash: { type: String, required: true, immutable: true },
    tokenAmount: { type: String, required: true, immutable: true },
    price: { type: String, required: true, immutable: true },
    paidCapacity: { type: String, required: true, immutable: true },
    blockNumber: { type: String, required: true, immutable: true },
    blockHash: { type: String, required: true, immutable: true },
    confirmedAtBlock: { type: String, required: true, immutable: true },
    lastEventId: { type: String, required: true },
  },
  { timestamps: true },
);

TradeSchema.index({ settlementTxHash: 1 }, { unique: true });
TradeSchema.index({ "buyOrderOutPoint.txHash": 1, "buyOrderOutPoint.index": 1 });
TradeSchema.index({ "sellOrderOutPoint.txHash": 1, "sellOrderOutPoint.index": 1 });
TradeSchema.index({ xudtTypeHash: 1, confirmedAtBlock: -1 });
TradeSchema.index({ sellerLockHash: 1, confirmedAtBlock: -1 });

const TradeModel = mongoose.model<TradeDocument>("Trade", TradeSchema);
export default TradeModel;