import mongoose, { Schema } from "mongoose";

// One document per recipient lock hash - the cooldown key. `address` is kept only for
// display/debugging; the lock hash is what's actually compared, since a lock has exactly
// one hash but can be rendered as several different address strings.
export const FaucetClaimSchema = new Schema(
  {
    _id: { type: String, required: true }, // recipient lock hash
    address: { type: String, required: true }, // last address string used to claim
    lastClaimedAt: { type: Date, required: true },
    claimCount: { type: Number, required: true, default: 0 },
    lastTxHash: { type: String, default: null },
  },
  { timestamps: true },
);

export default mongoose.model("FaucetClaim", FaucetClaimSchema);
