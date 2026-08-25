// Defines the MongoDB projection for a single supported xUDT sell-order cell and its lifecycle.
import mongoose, { Schema } from "mongoose";

export type OrderStatus =
  | "DISCOVERED"
  | "LIVE"
  | "SETTLEMENT_SUBMITTED"
  | "FILLED"
  | "CANCELLED"
  | "INVALID"
  | "ORPHANED";

export interface OrderDocument {
  _id: string;
  outPoint: {
    txHash: string;
    index: string;
  };
  orderCellLockHash: string;
  dexLockArgs: string;
  typeScriptHash: string;
  xudtTypeHash: string;
  makerLockHash: string;
  makerAddress?: string;
  side: "SELL";
  tokenAmount: string;
  orderCapacity: string;
  totalAskCapacity: string;
  status: OrderStatus;
  createdAtBlock?: string;
  createdAtTxHash: string;
  confirmedAtBlock?: string;
  settlementTxHash?: string;
  lastEventId: string;
  createdAt: Date;
  updatedAt: Date;
}

const OutPointSchema = new Schema(
  {
    txHash: { type: String, required: true },
    index: { type: String, required: true },
  },
  { _id: false },
);

export const ORDER_STATUS_VALUES: OrderStatus[] = [
  "DISCOVERED",
  "LIVE",
  "SETTLEMENT_SUBMITTED",
  "FILLED",
  "CANCELLED",
  "INVALID",
  "ORPHANED",
];

export const OrderSchema = new Schema<OrderDocument>(
  {
    _id: { type: String, required: true },
    outPoint: { type: OutPointSchema, required: true },
    orderCellLockHash: { type: String, required: true },
    dexLockArgs: { type: String, required: true },
    typeScriptHash: { type: String, required: true },
    xudtTypeHash: { type: String, required: true },
    makerLockHash: { type: String, required: true },
    makerAddress: { type: String },
    side: { type: String, enum: ["SELL"], required: true, default: "SELL" },
    tokenAmount: { type: String, required: true },
    orderCapacity: { type: String, required: true },
    totalAskCapacity: { type: String, required: true },
    status: {
      type: String,
      enum: ORDER_STATUS_VALUES,
      required: true,
      default: "DISCOVERED",
    },
    createdAtBlock: { type: String },
    createdAtTxHash: { type: String, required: true },
    confirmedAtBlock: { type: String },
    settlementTxHash: { type: String },
    lastEventId: { type: String, required: true },
  },
  { timestamps: true },
);

OrderSchema.index({ "outPoint.txHash": 1, "outPoint.index": 1 }, { unique: true });
OrderSchema.index({ xudtTypeHash: 1, status: 1, totalAskCapacity: 1, createdAtBlock: 1 });
OrderSchema.index({ makerLockHash: 1, createdAt: -1 });
OrderSchema.index({ settlementTxHash: 1 });

const OrderModel = mongoose.model<OrderDocument>("Order", OrderSchema);
export default OrderModel;