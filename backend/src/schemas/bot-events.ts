// Declares and validates the versioned event payloads the bot sends to the backend.
import { z } from "zod";

const hashSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const outPointSchema = z.object({
  txHash: hashSchema,
  index: z.string().min(1),
});

const scriptSchema = z.object({
  codeHash: hashSchema,
  hashType: z.enum(["data", "type", "data1", "data2"]),
  args: z.string().regex(/^0x[0-9a-fA-F]*$/),
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
    lockScript: scriptSchema,
    typeScript: scriptSchema.optional(),
    cellData: z.string().regex(/^0x[0-9a-fA-F]*$/),
    capacity: z.string().min(1),
    ownerLock: scriptSchema,
    ownerLockHash: hashSchema,
    ownerAddress: z.string().optional(),
    direction: z.enum(["ASK", "BID"]),
    pricePerToken: z.string().min(1),
    tokenAmount: z.string().min(1),
    xudtTypeHash: hashSchema,
    blockNumber: z.string().min(1),
    txIndex: z.string().min(1),
  }),
});

export const orderCancelledEventSchema = botEventBaseSchema.extend({
  eventType: z.literal("order-cancelled"),
  outPoint: outPointSchema,
  cancelledByTxHash: hashSchema,
});

export const settlementSubmittedEventSchema = botEventBaseSchema.extend({
  eventType: z.literal("settlement-submitted"),
  orderOutPoints: z.array(outPointSchema).length(2),
  settlementTxHash: hashSchema,
});

export const tradeConfirmedEventSchema = botEventBaseSchema.extend({
  eventType: z.literal("trade-confirmed"),
  buyOrderOutPoint: outPointSchema,
  sellOrderOutPoint: outPointSchema,
  trade: z.object({
    settlementTxHash: hashSchema,
    buyerLockHash: hashSchema,
    sellerLockHash: hashSchema,
    xudtTypeHash: hashSchema,
    tokenAmount: z.string().min(1),
    price: z.string().min(1),
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