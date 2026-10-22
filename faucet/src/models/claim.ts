import mongoose, { Schema } from "mongoose";

export type ClaimStatus = "RESERVED" | "SENT";

// One document per recipient lock hash - the cooldown key. `address` is kept only for
// display/debugging; the lock hash is what's actually compared, since a lock has exactly
// one hash but can be rendered as several different address strings.
//
// A claim is reserved atomically *before* anything is sent (status RESERVED + reservedAt),
// then committed (SENT + lastClaimedAt) once the transaction is broadcast. lastClaimedAt only
// ever reflects a completed claim, so rolling a reservation back is just clearing its status.
export const FaucetClaimSchema = new Schema(
  {
    _id: { type: String, required: true }, // recipient lock hash
    address: { type: String, required: true }, // last address string used to claim
    status: { type: String, enum: ["RESERVED", "SENT"], default: "SENT" },
    reservedAt: { type: Date },
    reservationId: { type: String },
    lastClaimedAt: { type: Date },
    claimCount: { type: Number, required: true, default: 0 },
    lastTxHash: { type: String, default: null },
  },
  { timestamps: true },
);

export default mongoose.model("FaucetClaim", FaucetClaimSchema);
