import mongoose, { Schema } from "mongoose";

const ScriptSchema = new Schema({
  codeHash: { type: String, required: true },
  hashType: { type: String, enum: ["data", "type", "data1", "data2"], required: true },
  args:     { type: String, required: true },
}, { _id: false });

export const OrderSchema = new Schema({
  _id: { type: String },                      // `${txHash}:${index}`

  outPoint: {
    txHash: { type: String, required: true },
    index:  { type: Number, required: true },
  },

  // CANONICAL: byte-exact, straight from the indexer, never re-derived
  lockScript: { type: ScriptSchema, required: true },   // the DEX lock
  typeScript: { type: ScriptSchema, required: false },  // the xUDT script; absent for BUY orders, which hold plain CKB
  cellData:   { type: String, required: true },
  capacity:   { type: String, required: true },         // shannons

  // PROJECTION: decoded from lockScript.args, for querying and building
  ownerLock:     { type: ScriptSchema, required: true },  // ← used for payouts
  ownerLockHash: { type: String, required: true, index: true },
  ownerAddress:  { type: String, required: true },        // display only

  direction:      { type: String, enum: ["BID", "ASK"], required: true },
  pricePerToken:  { type: Schema.Types.Decimal128, required: true }, // shannons/token
  remainingAmount:{ type: String, required: true },       // u128 as string
  receivedAmount: { type: String, default: "0" },         // bids only

  tokenPair:   { type: String, required: true, index: true },
  udtTypeHash: { type: String, required: true },

  // chain position: the real time axis for price-time priority
  blockNumber: { type: Number, required: true },
  txIndex:     { type: Number, required: true },

  // bot coordination: yours alone, nothing on chain
  status: {
    type: String,
    enum: ["LIVE", "RESERVED", "PENDING", "FILLED", "CANCELED"],
    required: true,
    default: "LIVE",
  },
  reservedUntil: { type: Date, default: null },
  pendingTxHash: { type: String, default: null },
}, { timestamps: true });

// The matching query. Direction is in the key so each side scans only its own.
OrderSchema.index({ tokenPair: 1, direction: 1, status: 1, pricePerToken: 1, blockNumber: 1, txIndex: 1 });
// "my orders"
OrderSchema.index({ ownerLockHash: 1, status: 1 });
// reservation sweeper
OrderSchema.index({ status: 1, reservedUntil: 1 });

export default mongoose.model("Order", OrderSchema);