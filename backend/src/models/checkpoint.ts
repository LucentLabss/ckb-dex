// Persists scanned block hashes so the bot can detect reorgs and resume from a verified cursor.
import mongoose, { Schema } from "mongoose";

export interface ChainCheckpointDocument {
  blockNumber: number;
  blockHash: string;
  createdAt: Date;
}

export const ChainCheckpointSchema = new Schema<ChainCheckpointDocument>(
  {
    blockNumber: { type: Number, required: true },
    blockHash: { type: String, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

ChainCheckpointSchema.index({ blockNumber: 1 }, { unique: true });

const ChainCheckpointModel = mongoose.model<ChainCheckpointDocument>("ChainCheckpoint", ChainCheckpointSchema);

export default ChainCheckpointModel;
