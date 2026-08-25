// Declares and validates the versioned event payloads the bot sends to the backend.
import { z } from "zod";

const hashSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const outPointSchema = z.object({
  txHash: hashSchema,
  index: z.string().min(1),
});

const botEventBaseSchema = z.object({
  schemaVersion: z.literal(1),
  eventId: z.string().min(1),
  occurredAt: z.string().datetime(),
  transactionHash: hashSchema.optional(),
  blockNumber: z.string().min(1).optional(),
  blockHash: hashSchema.optional(),
  confirmations: z.number().int().nonnegative().optional(),
});

export const orderConfirmedEventSchema = botEventBaseSchema.extend({
  eventType: z.literal("order-confirmed"),
  outPoint: outPointSchema,
  order: z.object({
    orderCellLockHash: hashSchema,
    dexLockArgs: z.string().regex(/^0x[0-9a-fA-F]*$/),
    typeScriptHash: hashSchema,
    xudtTypeHash: hashSchema,
    makerLockHash: hashSchema,
    makerAddress: z.string().optional(),
    tokenAmount: z.string().min(1),
    orderCapacity: z.string().min(1),
    totalAskCapacity: z.string().min(1),
    createdAtTxHash: hashSchema,
    createdAtBlock: z.string().min(1).optional(),
  }),
});

export const orderCancelledEventSchema = botEventBaseSchema.extend({
  eventType: z.literal("order-cancelled"),
  outPoint: outPointSchema,
  cancelledByTxHash: hashSchema,
});

export const settlementSubmittedEventSchema = botEventBaseSchema.extend({
  eventType: z.literal("settlement-submitted"),
  outPoint: outPointSchema,
  settlementTxHash: hashSchema,
});

export const tradeConfirmedEventSchema = botEventBaseSchema.extend({
  eventType: z.literal("trade-confirmed"),
  outPoint: outPointSchema,
  trade: z.object({
    settlementTxHash: hashSchema,
    makerLockHash: hashSchema,
    buyerLockHash: hashSchema,
    xudtTypeHash: hashSchema,
    tokenAmount: z.string().min(1),
    totalAskCapacity: z.string().min(1),
    orderCapacity: z.string().min(1),
    paidCapacity: z.string().min(1),
    confirmedAtBlock: z.string().min(1),
  }),
});

export const chainReorgEventSchema = botEventBaseSchema.extend({
  eventType: z.literal("chain-reorg"),
  revertedBlockHash: hashSchema,
  revertedBlockNumber: z.string().min(1),
  reason: z.string().min(1).optional(),
});

export const botEventSchema = z.discriminatedUnion("eventType", [
  orderConfirmedEventSchema,
  orderCancelledEventSchema,
  settlementSubmittedEventSchema,
  tradeConfirmedEventSchema,
  chainReorgEventSchema,
]);

export type BotEventBase = z.infer<typeof botEventBaseSchema>;
export type OrderConfirmedEvent = z.infer<typeof orderConfirmedEventSchema>;
export type OrderCancelledEvent = z.infer<typeof orderCancelledEventSchema>;
export type SettlementSubmittedEvent = z.infer<typeof settlementSubmittedEventSchema>;
export type TradeConfirmedEvent = z.infer<typeof tradeConfirmedEventSchema>;
export type ChainReorgEvent = z.infer<typeof chainReorgEventSchema>;
export type BotEvent = z.infer<typeof botEventSchema>;