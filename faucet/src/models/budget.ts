import mongoose, { Schema } from "mongoose";

// Global spend for one UTC day, shared by every caller. `_id` is the day ("YYYY-MM-DD"), so a
// new day starts from zero without any cleanup job.
export const FaucetBudgetSchema = new Schema(
  {
    _id: { type: String, required: true },
    claims: { type: Number, required: true, default: 0 },
    tokens: { type: Schema.Types.Decimal128, required: true, default: () => mongoose.Types.Decimal128.fromString("0") },
  },
  { timestamps: true },
);

export default mongoose.model("FaucetBudget", FaucetBudgetSchema);
