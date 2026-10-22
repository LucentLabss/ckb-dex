// Applies idempotent bot events to MongoDB order and trade projections while enforcing lifecycle rules.
import mongoose, { ClientSession } from "mongoose";
import {
  BotEvent,
  ChainReorgEvent,
  OrderCancelledEvent,
  OrderConfirmedEvent,
  SettlementSubmittedEvent,
  TradeConfirmedEvent,
} from "../schemas/index.js";
import {
  IngestionEventDocument,
  OrderStatus,
} from "../models/index.js";
import IngestionEventModel from "../models/ingestion-event.js";
import OrderModel from "../models/order.js";
import TradeModel from "../models/trade.js";
import { HydratedDocument } from "mongoose";
import type { OrderDocument } from "../models/order.js";
import { RealtimeBroadcaster } from "./realtime.js";

type IngestionResultStatus = "APPLIED" | "IGNORED";

export interface IngestionResult {
  status: IngestionResultStatus;
  eventId: string;
  reason?: string;
}

const allowedTransitions: Record<OrderStatus, OrderStatus[]> = {
  DISCOVERED: ["LIVE", "RESERVED", "PENDING", "SETTLEMENT_SUBMITTED", "CANCELED", "CANCELLED", "FILLED", "INVALID", "ORPHANED"],
  LIVE: ["RESERVED", "PENDING", "SETTLEMENT_SUBMITTED", "CANCELED", "CANCELLED", "FILLED", "INVALID", "ORPHANED"],
  RESERVED: ["LIVE", "PENDING", "CANCELED", "CANCELLED", "FILLED", "INVALID", "ORPHANED"],
  PENDING: ["LIVE", "CANCELED", "CANCELLED", "FILLED", "INVALID", "ORPHANED"],
  SETTLEMENT_SUBMITTED: ["PENDING", "FILLED", "CANCELED", "CANCELLED", "ORPHANED", "INVALID"],
  FILLED: ["ORPHANED"],
  CANCELED: ["ORPHANED"],
  CANCELLED: ["ORPHANED"],
  INVALID: [],
  ORPHANED: ["LIVE", "CANCELED", "CANCELLED", "FILLED", "INVALID"],
};

/** Per-event write context: every DB call joins `session`; realtime pushes wait for commit. */
interface ApplyContext {
  session: ClientSession;
  afterCommit: Array<() => Promise<unknown>>;
}

function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: number }).code === 11000;
}

function toOrderId(txHash: string, index: string): string {
  return `${txHash}:${index}`;
}

function hasConfirmation(event: BotEvent): boolean {
  if (event.confirmations != undefined) {
    return event.confirmations > 0;
  }

  return event.blockNumber != undefined && event.blockHash != undefined;
}

function canTransition(currentStatus: OrderStatus, nextStatus: OrderStatus): boolean {
  return allowedTransitions[currentStatus].includes(nextStatus);
}

async function persistIngestionEvent(input: {
  event: BotEvent;
  processingStatus: IngestionEventDocument["processingStatus"];
  processingError?: string;
  session?: ClientSession;
}): Promise<void> {
  await IngestionEventModel.create([{
    eventId: input.event.eventId,
    schemaVersion: input.event.schemaVersion,
    eventType: input.event.eventType,
    occurredAt: new Date(input.event.occurredAt),
    transactionHash: input.event.transactionHash,
    blockNumber: input.event.blockNumber,
    blockHash: input.event.blockHash,
    confirmations: input.event.confirmations,
    payload: input.event,
    processingStatus: input.processingStatus,
    processingError: input.processingError,
    processedAt: new Date(),
  }], { session: input.session });
}

async function updateOrderStatus(
  order: HydratedDocument<import("../models").OrderDocument>,
  nextStatus: OrderStatus,
  eventId: string,
  session?: ClientSession,
): Promise<void> {
  if (!canTransition(order.status, nextStatus)) {
    throw new Error(`Invalid order transition from ${order.status} to ${nextStatus}`);
  }

  order.status = nextStatus;
  order.lastEventId = eventId;
  await order.save({ session });
}

export class EventIngestionService {
  private readonly realtime = RealtimeBroadcaster.getInstance();

  public async ingest(event: BotEvent): Promise<IngestionResult> {
    const existing = await IngestionEventModel.findOne({ eventId: event.eventId }).lean();
    if (existing != undefined) {
      return {
        status: "IGNORED",
        eventId: event.eventId,
        reason: "duplicate-event-id",
      };
    }

    const session = await mongoose.startSession();
    let afterCommit: ApplyContext["afterCommit"] = [];

    try {
      // The projection update and the dedupe record commit together or not at all.
      // withTransaction may re-run the callback, so the context is rebuilt each attempt.
      const result = await session.withTransaction(async () => {
        const ctx: ApplyContext = { session, afterCommit: [] };
        const applied = await this.applyEvent(event, ctx);
        await persistIngestionEvent({
          event,
          processingStatus: applied.status,
          processingError: applied.reason,
          session,
        });
        afterCommit = ctx.afterCommit;
        return applied;
      }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } });

      // Realtime pushes read committed data, so they run only after the commit.
      await Promise.allSettled(afterCommit.map((push) => push()));
      return result as IngestionResult;
    } catch (error) {
      // A concurrent delivery of the same event won the unique index: treat as a duplicate.
      if (isDuplicateKeyError(error)) {
        return { status: "IGNORED", eventId: event.eventId, reason: "duplicate-event-id" };
      }

      const message = error instanceof Error ? error.message : "unknown-error";

      // Outside the (aborted) transaction so the failure is still auditable.
      try {
        await persistIngestionEvent({
          event,
          processingStatus: "FAILED",
          processingError: message,
        });
      } catch (persistError) {
        console.error("Failed to persist failed ingestion event", persistError);
      }

      throw error;
    } finally {
      await session.endSession();
    }
  }

  private async applyEvent(event: BotEvent, ctx: ApplyContext): Promise<IngestionResult> {
    switch (event.eventType) {
      case "order-confirmed":
        return this.applyOrderConfirmed(event, ctx);
      case "order-cancelled":
        return this.applyOrderCancelled(event, ctx);
      case "settlement-submitted":
        return this.applySettlementSubmitted(event, ctx);
      case "trade-confirmed":
        return this.applyTradeConfirmed(event, ctx);
      case "chain-reorg":
        return this.applyChainReorg(event, ctx);
    }
  }

  private async applyOrderConfirmed(event: OrderConfirmedEvent, ctx: ApplyContext): Promise<IngestionResult> {
    const orderId = toOrderId(event.outPoint.txHash, event.outPoint.index);

    const updatePayload: Partial<OrderDocument> = {
      outPoint: {
        txHash: event.outPoint.txHash,
        index: event.outPoint.index,
      },
      lockScript: event.order.lockScript,
      typeScript: event.order.typeScript,
      cellData: event.order.cellData,
      capacity: event.order.capacity,
      ownerLock: event.order.ownerLock,
      ownerLockHash: event.order.ownerLockHash,
      ownerAddress: event.order.ownerAddress,
      direction: event.order.direction,
      pricePerToken: event.order.pricePerToken,
      remainingAmount: event.order.tokenAmount,
      tokenPair: `${event.order.xudtTypeHash}:CKB`,
      xudtTypeHash: event.order.xudtTypeHash,
      blockNumber: event.order.blockNumber,
      txIndex: event.order.txIndex,
      status: "LIVE",
      confirmedAtBlock: event.blockNumber,
      lastEventId: event.eventId,
    };

    await OrderModel.findByIdAndUpdate(
      orderId,
      { $set: updatePayload },
      {
        upsert: true,
        returnDocument: "after",
        setDefaultsOnInsert: true,
        session: ctx.session,
      },
    );

    ctx.afterCommit.push(() => Promise.all([
      this.realtime.emitOrderbook(event.order.xudtTypeHash),
      this.realtime.emitMakerOrders(event.order.ownerLockHash),
    ]));

    return { status: "APPLIED", eventId: event.eventId };
  }

  private async applyOrderCancelled(event: OrderCancelledEvent, ctx: ApplyContext): Promise<IngestionResult> {
    if (!hasConfirmation(event)) {
      return {
        status: "IGNORED",
        eventId: event.eventId,
        reason: "order-cancelled-without-confirmation",
      };
    }

    const orderId = toOrderId(event.outPoint.txHash, event.outPoint.index);
    const order = await OrderModel.findById(orderId).session(ctx.session);

    if (order == undefined) {
      return {
        status: "IGNORED",
        eventId: event.eventId,
        reason: "order-not-found",
      };
    }

    await updateOrderStatus(order, "CANCELED", event.eventId, ctx.session);
    order.confirmedAtBlock = event.blockNumber;
    order.settlementTxHash = event.cancelledByTxHash;
    await order.save({ session: ctx.session });

    ctx.afterCommit.push(() => Promise.all([
      this.realtime.emitOrderbook(order.xudtTypeHash),
      this.realtime.emitMakerOrders(order.ownerLockHash),
    ]));

    return { status: "APPLIED", eventId: event.eventId };
  }

  private async applySettlementSubmitted(event: SettlementSubmittedEvent, ctx: ApplyContext): Promise<IngestionResult> {
    const orderIds = event.orderOutPoints.map((outPoint) => toOrderId(outPoint.txHash, outPoint.index));
    const orders = await OrderModel.find({ _id: { $in: orderIds } }).session(ctx.session);

    if (orders.length !== event.orderOutPoints.length) {
      return {
        status: "IGNORED",
        eventId: event.eventId,
        reason: "order-not-found",
      };
    }

    if (orders.some((order) => !canTransition(order.status, "PENDING"))) {
      return {
        status: "IGNORED",
        eventId: event.eventId,
        reason: "invalid-transition-to-pending",
      };
    }

    // Sequential: operations on one transaction session must not run in parallel.
    for (const order of orders) {
      order.status = "PENDING";
      order.pendingTxHash = event.settlementTxHash;
      order.settlementTxHash = event.settlementTxHash;
      order.lastEventId = event.eventId;
      await order.save({ session: ctx.session });
    }

    ctx.afterCommit.push(async () => {
      await Promise.all([
        ...new Set(orders.map((order) => order.xudtTypeHash)),
      ].map((xudtTypeHash) => this.realtime.emitOrderbook(xudtTypeHash)));
      await Promise.all(orders.map((order) => this.realtime.emitMakerOrders(order.ownerLockHash)));
    });

    return { status: "APPLIED", eventId: event.eventId };
  }

  private async applyTradeConfirmed(event: TradeConfirmedEvent, ctx: ApplyContext): Promise<IngestionResult> {
    if (!hasConfirmation(event)) {
      return {
        status: "IGNORED",
        eventId: event.eventId,
        reason: "trade-confirmed-without-confirmation",
      };
    }

    const buyOrderId = toOrderId(event.buyOrderOutPoint.txHash, event.buyOrderOutPoint.index);
    const sellOrderId = toOrderId(event.sellOrderOutPoint.txHash, event.sellOrderOutPoint.index);
    const orders = await OrderModel.find({ _id: { $in: [buyOrderId, sellOrderId] } }).session(ctx.session);

    if (orders.length !== 2) {
      return {
        status: "IGNORED",
        eventId: event.eventId,
        reason: "order-not-found",
      };
    }

    if (orders.some((order) => !canTransition(order.status, "FILLED"))) {
      return {
        status: "IGNORED",
        eventId: event.eventId,
        reason: "invalid-transition-to-filled",
      };
    }

    for (const order of orders) {
      order.status = "FILLED";
      order.confirmedAtBlock = event.trade.confirmedAtBlock;
      order.pendingTxHash = event.trade.settlementTxHash;
      order.settlementTxHash = event.trade.settlementTxHash;
      order.lastEventId = event.eventId;
      await order.save({ session: ctx.session });
    }

    const tradeId = event.trade.settlementTxHash;

    await TradeModel.findByIdAndUpdate(
      tradeId,
      {
        $setOnInsert: {
          _id: tradeId,
          settlementTxHash: event.trade.settlementTxHash,
          buyOrderOutPoint: {
            txHash: event.buyOrderOutPoint.txHash,
            index: event.buyOrderOutPoint.index,
          },
          sellOrderOutPoint: {
            txHash: event.sellOrderOutPoint.txHash,
            index: event.sellOrderOutPoint.index,
          },
          buyerLockHash: event.trade.buyerLockHash,
          sellerLockHash: event.trade.sellerLockHash,
          xudtTypeHash: event.trade.xudtTypeHash,
          tokenAmount: event.trade.tokenAmount,
          price: event.trade.price,
          paidCapacity: event.trade.paidCapacity,
          blockNumber: event.blockNumber ?? event.trade.confirmedAtBlock,
          blockHash: event.blockHash ?? "",
          confirmedAtBlock: event.trade.confirmedAtBlock,
        },
        $set: {
          lastEventId: event.eventId,
        },
      },
      {
        upsert: true,
        returnDocument: "after",
        setDefaultsOnInsert: true,
        session: ctx.session,
      },
    );

    ctx.afterCommit.push(() => Promise.all([
      this.realtime.emitOrderbook(event.trade.xudtTypeHash),
      this.realtime.emitTrades(event.trade.xudtTypeHash),
      ...orders.map((order) => this.realtime.emitMakerOrders(order.ownerLockHash)),
    ]));

    return { status: "APPLIED", eventId: event.eventId };
  }

  private async applyChainReorg(event: ChainReorgEvent, ctx: ApplyContext): Promise<IngestionResult> {
    const revertedBlock = BigInt(event.revertedBlockNumber);

    const candidates = await OrderModel.find({
      $or: [
        { createdAtBlock: { $exists: true } },
        { confirmedAtBlock: { $exists: true } },
      ],
    }).session(ctx.session);

    for (const order of candidates) {
      const createdAtBlock = order.createdAtBlock != undefined ? BigInt(order.createdAtBlock) : undefined;
      const confirmedAtBlock = order.confirmedAtBlock != undefined ? BigInt(order.confirmedAtBlock) : undefined;

      if (
        (createdAtBlock != undefined && createdAtBlock >= revertedBlock) ||
        (confirmedAtBlock != undefined && confirmedAtBlock >= revertedBlock)
      ) {
        if (order.status !== "ORPHANED") {
          await updateOrderStatus(order, "ORPHANED", event.eventId, ctx.session);
        }
      }
    }

    return { status: "APPLIED", eventId: event.eventId };
  }
}
