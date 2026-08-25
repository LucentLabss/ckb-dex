// Defines the immutable MongoDB projection for a confirmed settlement trade.
import mongoose, { Schema } from "mongoose";

export interface TradeDocument {
  _id: string;
  settlementTxHash: string;
  orderOutPoint: {
    txHash: string;
    index: string;
  };
  makerLockHash: string;
  buyerLockHash: string;
  xudtTypeHash: string;
  tokenAmount: string;
  totalAskCapacity: string;
  orderCapacity: string;
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
    orderOutPoint: { type: OutPointSchema, required: true, immutable: true },
    makerLockHash: { type: String, required: true, immutable: true },
    buyerLockHash: { type: String, required: true, immutable: true },
    xudtTypeHash: { type: String, required: true, immutable: true },
    tokenAmount: { type: String, required: true, immutable: true },
    totalAskCapacity: { type: String, required: true, immutable: true },
    orderCapacity: { type: String, required: true, immutable: true },
    paidCapacity: { type: String, required: true, immutable: true },
    blockNumber: { type: String, required: true, immutable: true },
    blockHash: { type: String, required: true, immutable: true },
    confirmedAtBlock: { type: String, required: true, immutable: true },
    lastEventId: { type: String, required: true },
  },
  { timestamps: true },
);

TradeSchema.index({ settlementTxHash: 1 }, { unique: true });
TradeSchema.index({ "orderOutPoint.txHash": 1, "orderOutPoint.index": 1 });
TradeSchema.index({ xudtTypeHash: 1, confirmedAtBlock: -1 });
TradeSchema.index({ makerLockHash: 1, confirmedAtBlock: -1 });

const TradeModel = mongoose.model<TradeDocument>("Trade", TradeSchema);
export default TradeModel;