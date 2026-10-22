// Defines the MongoDB projection for canonical CKB buy and sell order cells.
import mongoose, { Schema } from "mongoose";

export type OrderDirection = "ASK" | "BID";

export type OrderStatus =
  | "DISCOVERED"
  | "LIVE"
  | "RESERVED"
  | "PENDING"
  | "FILLED"
  | "CANCELED"
  | "INVALID"
  | "ORPHANED"
  | "SETTLEMENT_SUBMITTED"
  | "CANCELLED";

export interface ScriptDocument {
  codeHash: string;
  hashType: string;
  args: string;
}

export interface OrderDocument {
  _id: string;
  outPoint: { txHash: string; index: string };
  lockScript: ScriptDocument;
  typeScript?: ScriptDocument;
  cellData: string;
  capacity: string;
  ownerLock: ScriptDocument;
  ownerLockHash: string;
  ownerAddress?: string;
  direction: OrderDirection;
  pricePerToken: string;
  remainingAmount: string;
  tokenPair: string;
  xudtTypeHash: string;
  blockNumber: string;
  txIndex: string;
  status: OrderStatus;
  reservedUntil?: Date | null;
  pendingTxHash?: string | null;
  settlementTxHash?: string;
  lastEventId?: string;
  confirmedAtBlock?: string;
  orderCellLockHash?: string;
  dexLockArgs?: string;
  typeScriptHash?: string;
  makerLockHash?: string;
  makerAddress?: string;
  side?: "BUY" | "SELL";
  tokenAmount?: string;
  orderCapacity?: string;
  totalAskCapacity?: string;
  createdAtBlock?: string;
  createdAtTxHash?: string;
  /**
   * Numeric shadow keys so the database can sort and page: the string fields above hold
   * u64-sized values that sort lexicographically. Derived from the strings on ingestion.
   */
  priceValue?: mongoose.Types.Decimal128;
  blockNum?: number;
  txIdx?: number;
  /** Hash of the block that created the cell; lets a reorg tell re-included orders from reverted ones. */
  createdBlockHash?: string;
  /** Block and hash of the confirmed transaction that spent the cell (fill or cancel). */
  spentAtBlock?: string;
  spentBlockHash?: string;
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

const ScriptSchema = new Schema(
  {
    codeHash: { type: String, required: true },
    hashType: { type: String, required: true },
    args: { type: String, required: true },
  },
  { _id: false },
);

export const ORDER_STATUS_VALUES: OrderStatus[] = [
  "DISCOVERED",
  "LIVE",
  "RESERVED",
  "PENDING",
  "FILLED",
  "CANCELED",
  "INVALID",
  "ORPHANED",
  "SETTLEMENT_SUBMITTED",
  "CANCELLED",
];

export const OrderSchema = new Schema<OrderDocument>(
  {
    _id: { type: String, required: true },
    outPoint: { type: OutPointSchema, required: true },
    lockScript: { type: ScriptSchema, required: true },
    typeScript: { type: ScriptSchema },
    cellData: { type: String, required: true },
    capacity: { type: String, required: true },
    ownerLock: { type: ScriptSchema, required: true },
    ownerLockHash: { type: String, required: true },
    ownerAddress: { type: String },
    direction: { type: String, enum: ["ASK", "BID"], required: true },
    pricePerToken: { type: String, required: true },
    remainingAmount: { type: String, required: true },
    tokenPair: { type: String, required: true },
    xudtTypeHash: { type: String, required: true },
    blockNumber: { type: String, required: true },
    txIndex: { type: String, required: true },
    status: { type: String, enum: ORDER_STATUS_VALUES, required: true, default: "DISCOVERED" },
    reservedUntil: { type: Date, default: null },
    pendingTxHash: { type: String, default: null },
    settlementTxHash: { type: String },
    lastEventId: { type: String },
    confirmedAtBlock: { type: String },
    orderCellLockHash: { type: String },
    dexLockArgs: { type: String },
    typeScriptHash: { type: String },
    makerLockHash: { type: String },
    makerAddress: { type: String },
    side: { type: String, enum: ["BUY", "SELL"] },
    tokenAmount: { type: String },
    orderCapacity: { type: String },
    totalAskCapacity: { type: String },
    createdAtBlock: { type: String },
    createdAtTxHash: { type: String },
    priceValue: { type: Schema.Types.Decimal128 },
    blockNum: { type: Number },
    txIdx: { type: Number },
    createdBlockHash: { type: String },
    spentAtBlock: { type: String },
    spentBlockHash: { type: String },
  },
  { timestamps: true },
);

OrderSchema.index({ "outPoint.txHash": 1, "outPoint.index": 1 }, { unique: true });
// Order book: best price first per side (asks ascending, bids descending), then chain order.
OrderSchema.index({ xudtTypeHash: 1, status: 1, direction: 1, priceValue: 1, blockNum: 1, txIdx: 1, _id: 1 });
OrderSchema.index({ xudtTypeHash: 1, status: 1, direction: 1, priceValue: -1, blockNum: 1, txIdx: 1, _id: 1 });
OrderSchema.index({ xudtTypeHash: 1, status: 1, priceValue: 1, blockNum: 1, txIdx: 1, _id: 1 });
// Listings, newest first.
OrderSchema.index({ ownerLockHash: 1, createdAt: -1, _id: 1 });
OrderSchema.index({ xudtTypeHash: 1, createdAt: -1, _id: 1 });
OrderSchema.index({ status: 1, createdAt: -1, _id: 1 });
OrderSchema.index({ pendingTxHash: 1 });
OrderSchema.index({ settlementTxHash: 1 });

const OrderModel = mongoose.model<OrderDocument>("Order", OrderSchema);
export default OrderModel;