// Defines the MongoDB audit model used to deduplicate and track bot event processing.
import mongoose, { Schema } from "mongoose";

export type IngestionEventType =
  | "order-confirmed"
  | "order-cancelled"
  | "settlement-submitted"
  | "trade-confirmed"
  | "chain-reorg";

export type IngestionProcessingStatus = "APPLIED" | "IGNORED" | "FAILED";

export interface IngestionEventDocument {
  eventId: string;
  schemaVersion: 1;
  eventType: IngestionEventType;
  occurredAt: Date;
  transactionHash?: string;
  blockNumber?: string;
  blockHash?: string;
  confirmations?: number;
  payload: Record<string, unknown>;
  processingStatus: IngestionProcessingStatus;
  processingError?: string;
  processedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const INGESTION_EVENT_TYPES: IngestionEventType[] = [
  "order-confirmed",
  "order-cancelled",
  "settlement-submitted",
  "trade-confirmed",
  "chain-reorg",
];

const PROCESSING_STATUSES: IngestionProcessingStatus[] = [
  "APPLIED",
  "IGNORED",
  "FAILED",
];

export const IngestionEventSchema = new Schema<IngestionEventDocument>(
  {
    eventId: { type: String, required: true },
    schemaVersion: { type: Number, required: true, enum: [1] },
    eventType: { type: String, required: true, enum: INGESTION_EVENT_TYPES },
    occurredAt: { type: Date, required: true },
    transactionHash: { type: String },
    blockNumber: { type: String },
    blockHash: { type: String },
    confirmations: { type: Number },
    payload: { type: Schema.Types.Mixed, required: true },
    processingStatus: {
      type: String,
      required: true,
      enum: PROCESSING_STATUSES,
      default: "APPLIED",
    },
    processingError: { type: String },
    processedAt: { type: Date, required: true, default: () => new Date() },
  },
  { timestamps: true },
);

IngestionEventSchema.index({ eventId: 1 }, { unique: true });
IngestionEventSchema.index({ eventType: 1, occurredAt: -1 });
IngestionEventSchema.index({ processingStatus: 1, processedAt: -1 });

const IngestionEventModel = mongoose.model<IngestionEventDocument>(
  "IngestionEvent",
  IngestionEventSchema,
);

export default IngestionEventModel;