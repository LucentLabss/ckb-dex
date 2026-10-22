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
import AppError from "./error.js";
import { getChainVerification } from "./chain-verifier.js";
import { verifyEvent } from "./event-verification.js";

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

/** Failed deliveries are auditable but retryable: one record per eventId, rewritten on each failure. */
async function recordFailedEvent(event: BotEvent, message: string): Promise<void> {
  await IngestionEventModel.updateOne(
    { eventId: event.eventId, processingStatus: "FAILED" },
    {
      $set: {
        schemaVersion: event.schemaVersion,
        eventType: event.eventType,
        occurredAt: new Date(event.occurredAt),
        transactionHash: event.transactionHash,
        blockNumber: event.blockNumber,
        blockHash: event.blockHash,
        confirmations: event.confirmations,
        payload: event,
        processingStatus: "FAILED",
        processingError: message,
        processedAt: new Date(),
      },
    },
    { upsert: true },
  );
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
    // A FAILED record is an audit trail, not a tombstone: only a processed event is a duplicate.
    const existing = await IngestionEventModel.findOne({
      eventId: event.eventId,
      processingStatus: { $ne: "FAILED" },
    }).lean();
    if (existing != undefined) {
      return {
        status: "IGNORED",
        eventId: event.eventId,
        reason: "duplicate-event-id",
      };
    }

    // Nothing the producer claims reaches the projection until the chain agrees.
    await this.verify(event);

    const session = await mongoose.startSession();
    let afterCommit: ApplyContext["afterCommit"] = [];

    try {
      // The projection update and the dedupe record commit together or not at all.
      // withTransaction may re-run the callback, so the context is rebuilt each attempt.
      const result = await session.withTransaction(async () => {
        const ctx: ApplyContext = { session, afterCommit: [] };
        const applied = await this.applyEvent(event, ctx);
        await IngestionEventModel.deleteOne({ eventId: event.eventId, processingStatus: "FAILED" }, { session });
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

      await this.auditFailure(event, error);
      throw error;
    } finally {
      await session.endSession();
    }
  }

  /** Runs chain verification; rejections are audited, transient RPC trouble is reported as 503. */
  private async verify(event: BotEvent): Promise<void> {
    const verification = getChainVerification();
    try {
      await verifyEvent(event, verification, async (ids) =>
        OrderModel.find({ _id: { $in: ids } }).lean());
    } catch (error) {
      if (error instanceof AppError) {
        // 409 means "not deep enough yet": retryable and not worth an audit row.
        if (error.statusCode === 422) await this.auditFailure(event, error);
        throw error;
      }
      throw new AppError(503, `Unable to verify event against CKB: ${error instanceof Error ? error.message : "rpc error"}`);
    }
  }

  private async auditFailure(event: BotEvent, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : "unknown-error";
    // Outside any (aborted) transaction so the failure is still recorded.
    try {
      await recordFailedEvent(event, message);
    } catch (persistError) {
      console.error("Failed to persist failed ingestion event", persistError);
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

    // Redelivery must not clobber an order the pipeline has already moved on. A different
    // creating block (re-inclusion after a reorg) is the one case that re-opens an order.
    const existing = await OrderModel.findById(orderId).session(ctx.session);
    if (existing != undefined && existing.createdBlockHash === event.blockHash && existing.status !== "ORPHANED") {
      return { status: "IGNORED", eventId: event.eventId, reason: "order-already-indexed" };
    }

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
      createdAtBlock: event.order.blockNumber,
      createdBlockHash: event.blockHash,
      confirmedAtBlock: event.blockNumber,
      lastEventId: event.eventId,
      reservedUntil: null,
      pendingTxHash: null,
    };

    await OrderModel.findByIdAndUpdate(
      orderId,
      {
        $set: updatePayload,
        // A re-created order starts clean: any earlier spend belonged to a reverted block.
        $unset: { settlementTxHash: "", spentAtBlock: "", spentBlockHash: "" },
      },
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
    order.spentAtBlock = event.blockNumber;
    order.spentBlockHash = event.blockHash;
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
      order.spentAtBlock = event.trade.confirmedAtBlock;
      order.spentBlockHash = event.blockHash;
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
        },
        // Block facts are $set so a trade re-confirmed after a reorg replaces the reverted ones.
        $set: {
          blockNumber: event.blockNumber ?? event.trade.confirmedAtBlock,
          blockHash: event.blockHash ?? "",
          confirmedAtBlock: event.trade.confirmedAtBlock,
          status: "CONFIRMED",
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

  /**
   * Rolls the projection back to the state implied by the canonical chain below
   * `revertedBlockNumber`: orders created in reverted blocks are orphaned until a rescan
   * re-confirms them, orders whose fill/cancel was reverted return to LIVE (the next
   * liveness sweep re-checks the cell), and trades from reverted blocks are marked REVERTED.
   */
  private async applyChainReorg(event: ChainReorgEvent, ctx: ApplyContext): Promise<IngestionResult> {
    // Roll back everything above the last block known to be canonical.
    const from = event.ancestorBlockNumber !== undefined
      ? Number(event.ancestorBlockNumber) + 1
      : Number(event.revertedBlockNumber);
    const atOrAfter = (field: string) => ({
      $expr: {
        $gte: [{ $convert: { input: `$${field}`, to: "long", onError: null, onNull: null } }, from],
      },
    });
    const session = ctx.session;

    const createdReverted = await OrderModel.find({
      ...atOrAfter("blockNumber"),
      status: { $ne: "ORPHANED" },
    }).session(session);
    const spentReverted = await OrderModel.find({
      ...atOrAfter("spentAtBlock"),
      status: { $in: ["FILLED", "CANCELED", "CANCELLED"] },
      _id: { $nin: createdReverted.map((order) => order._id) },
    }).session(session);

    for (const order of createdReverted) {
      order.status = "ORPHANED";
      order.reservedUntil = null;
      order.pendingTxHash = null;
      order.lastEventId = event.eventId;
      await order.save({ session });
    }

    for (const order of spentReverted) {
      order.status = "LIVE";
      order.reservedUntil = null;
      order.pendingTxHash = null;
      order.spentAtBlock = undefined;
      order.spentBlockHash = undefined;
      order.settlementTxHash = undefined;
      order.lastEventId = event.eventId;
      await order.save({ session });
    }

    const revertedTrades = await TradeModel.find({
      ...atOrAfter("blockNumber"),
      status: { $ne: "REVERTED" },
    }).session(session);
    for (const trade of revertedTrades) {
      trade.status = "REVERTED";
      trade.lastEventId = event.eventId;
      await trade.save({ session });
    }

    const touched = [...createdReverted, ...spentReverted];
    ctx.afterCommit.push(async () => {
      await Promise.all([
        ...new Set([...touched.map((order) => order.xudtTypeHash), ...revertedTrades.map((trade) => trade.xudtTypeHash)]),
      ].flatMap((xudtTypeHash) => [
        this.realtime.emitOrderbook(xudtTypeHash),
        this.realtime.emitTrades(xudtTypeHash),
      ]));
      await Promise.all([...new Set(touched.map((order) => order.ownerLockHash))]
        .map((ownerLockHash) => this.realtime.emitMakerOrders(ownerLockHash)));
    });

    return { status: "APPLIED", eventId: event.eventId };
  }
}
