// Exposes read-only REST endpoints for markets, live orders, maker history, and confirmed trades.
import { Router, Request, Response } from "express";
import { z } from "zod";

import OrderModel from "../models/order.js";
import TradeModel from "../models/trade.js";
import { sendSuccess } from "../utils/index.js";

const router = Router();

const paginationSchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(25),
});

const orderQuerySchema = z.object({
  xudtTypeHash: z.string().min(1).optional(),
  makerLockHash: z.string().min(1).optional(),
  direction: z.enum(["ASK", "BID"]).optional(),
  status: z.enum([
    "DISCOVERED",
    "LIVE",
    "RESERVED",
    "PENDING",
    "SETTLEMENT_SUBMITTED",
    "FILLED",
    "CANCELED",
    "CANCELLED",
    "INVALID",
    "ORPHANED",
  ]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(25),
  cursor: z.string().optional(),
});

router.get("/markets", async (_req: Request, res: Response) => {
  const markets = await OrderModel.distinct("xudtTypeHash");
  return sendSuccess(res, "Markets fetched", {
    requestId: res.locals.requestId,
    markets,
  });
});

router.get("/order-book", async (req: Request, res: Response) => {
  const query = paginationSchema.parse(req.query);
  const xudtTypeHash = typeof req.query.xudtTypeHash === "string" ? req.query.xudtTypeHash : undefined;
  const direction = req.query.direction === "ASK" || req.query.direction === "BID" ? req.query.direction : undefined;

  const filter: Record<string, string> = { status: "LIVE" };
  if (xudtTypeHash) {
    filter.xudtTypeHash = xudtTypeHash;
  }
  if (direction) {
    filter.direction = direction;
  }

  const items = await OrderModel.find(filter as Record<string, unknown>).lean();
  items.sort((left, right) => {
    const leftPrice = BigInt(left.pricePerToken);
    const rightPrice = BigInt(right.pricePerToken);
    if (leftPrice !== rightPrice) {
      const ascending = direction !== "BID";
      return ascending === (leftPrice < rightPrice) ? -1 : 1;
    }

    const leftBlock = BigInt(left.blockNumber);
    const rightBlock = BigInt(right.blockNumber);
    if (leftBlock !== rightBlock) return leftBlock < rightBlock ? -1 : 1;
    return BigInt(left.txIndex) < BigInt(right.txIndex) ? -1 : 1;
  });

  return sendSuccess(res, "Order book fetched", {
    requestId: res.locals.requestId,
    items: items.slice(0, query.limit),
    nextCursor: undefined,
    limit: query.limit,
  });
});

router.get("/orders/:txHash/:index", async (req: Request, res: Response) => {
  const { txHash, index } = req.params;
  const order = await OrderModel.findOne({ "outPoint.txHash": txHash, "outPoint.index": index }).lean();

  if (!order) {
    return sendSuccess(res, "Order not found", {
      requestId: res.locals.requestId,
      order: null,
    }, 404);
  }

  return sendSuccess(res, "Order fetched", {
    requestId: res.locals.requestId,
    order,
  });
});

router.get("/orders", async (req: Request, res: Response) => {
  const query = orderQuerySchema.parse(req.query);
  const filter: Record<string, string> = {};

  if (query.makerLockHash) filter.makerLockHash = query.makerLockHash;
  if (query.xudtTypeHash) filter.xudtTypeHash = query.xudtTypeHash;
  if (query.direction) filter.direction = query.direction;
  if (query.status) filter.status = query.status;

  const items = await OrderModel.find(filter)
    .sort({ createdAt: -1, "outPoint.txHash": 1 })
    .limit(query.limit)
    .lean();

  return sendSuccess(res, "Orders fetched", {
    requestId: res.locals.requestId,
    items,
    nextCursor: undefined,
    limit: query.limit,
  });
});

router.get("/trades", async (req: Request, res: Response) => {
  const query = z.object({
    xudtTypeHash: z.string().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(25),
  }).parse(req.query);

  const filter = query.xudtTypeHash ? { xudtTypeHash: query.xudtTypeHash } : {};
  const items = await TradeModel.find(filter)
    .sort({ confirmedAtBlock: -1, createdAt: -1 })
    .limit(query.limit)
    .lean();

  return sendSuccess(res, "Trades fetched", {
    requestId: res.locals.requestId,
    items,
    nextCursor: undefined,
    limit: query.limit,
  });
});

export default router;
