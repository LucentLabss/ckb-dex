// Exposes read-only REST endpoints for markets, live orders, maker history, and confirmed trades.
import { Router, Request, Response } from "express";
import mongoose from "mongoose";
import { z } from "zod";

import OrderModel, { ORDER_STATUS_VALUES } from "../models/order.js";
import TradeModel from "../models/trade.js";
import AppError from "../services/error.js";
import { cursorSchema, decodeCursor, encodeCursor, limitSchema, sendSuccess } from "../utils/index.js";

const router = Router();

const hashSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "Expected a 32-byte 0x-prefixed hash");
const directionSchema = z.enum(["ASK", "BID"]);

const orderBookQuerySchema = z.object({
  xudtTypeHash: hashSchema.optional(),
  direction: directionSchema.optional(),
  limit: limitSchema,
  cursor: cursorSchema,
});

const orderQuerySchema = z.object({
  xudtTypeHash: hashSchema.optional(),
  makerLockHash: hashSchema.optional(),
  direction: directionSchema.optional(),
  status: z.enum(ORDER_STATUS_VALUES as [string, ...string[]]).optional(),
  limit: limitSchema,
  cursor: cursorSchema,
});

const tradesQuerySchema = z.object({
  xudtTypeHash: hashSchema.optional(),
  limit: limitSchema,
  cursor: cursorSchema,
});

const orderBookCursor = z.object({ p: z.string().regex(/^\d{1,40}$/), b: z.number().int(), t: z.number().int(), i: z.string().max(200) });
const orderListCursor = z.object({ c: z.number().int(), i: z.string().max(200) });
const tradeCursor = z.object({ b: z.number().int(), i: z.string().max(200) });

/** Internal sort keys back the pagination but are not part of the public order shape. */
const stripSortKeys = <T extends object>(doc: T) => {
  const { priceValue: _price, blockNum: _block, txIdx: _tx, ...rest } = doc as T & Record<string, unknown>;
  return rest;
};

router.get("/markets", async (_req: Request, res: Response) => {
  const markets = await OrderModel.distinct("xudtTypeHash");
  return sendSuccess(res, "Markets fetched", {
    requestId: res.locals.requestId,
    markets,
  });
});

router.get("/order-book", async (req: Request, res: Response) => {
  const query = orderBookQuerySchema.parse(req.query);
  const cursor = decodeCursor(query.cursor, orderBookCursor);

  // Asks ascend and bids descend by price; ties resolve by chain order (price-time priority).
  const priceDirection = query.direction === "BID" ? -1 : 1;
  const filter: Record<string, unknown> = { status: "LIVE" };
  if (query.xudtTypeHash) filter.xudtTypeHash = query.xudtTypeHash;
  if (query.direction) filter.direction = query.direction;

  if (cursor) {
    const price = mongoose.Types.Decimal128.fromString(cursor.p);
    const pastPrice = { [priceDirection === 1 ? "$gt" : "$lt"]: price };
    filter.$or = [
      { priceValue: pastPrice },
      { priceValue: price, blockNum: { $gt: cursor.b } },
      { priceValue: price, blockNum: cursor.b, txIdx: { $gt: cursor.t } },
      { priceValue: price, blockNum: cursor.b, txIdx: cursor.t, _id: { $gt: cursor.i } },
    ];
  }

  const rows = await OrderModel.find(filter)
    .sort({ priceValue: priceDirection, blockNum: 1, txIdx: 1, _id: 1 })
    .limit(query.limit + 1)
    .lean();

  const page = rows.slice(0, query.limit);
  const last = page[page.length - 1];
  const nextCursor = rows.length > query.limit && last
    ? encodeCursor({ p: last.priceValue!.toString(), b: last.blockNum ?? 0, t: last.txIdx ?? 0, i: last._id })
    : undefined;

  return sendSuccess(res, "Order book fetched", {
    requestId: res.locals.requestId,
    items: page.map(stripSortKeys),
    nextCursor,
    limit: query.limit,
  });
});

router.get("/orders/:txHash/:index", async (req: Request, res: Response) => {
  const txHash = hashSchema.safeParse(req.params.txHash);
  const index = z.string().regex(/^\d{1,10}$/).safeParse(req.params.index);
  if (!txHash.success || !index.success) {
    throw new AppError(400, "Invalid order outpoint");
  }

  const order = await OrderModel.findOne({ "outPoint.txHash": txHash.data, "outPoint.index": index.data }).lean();

  if (!order) {
    return sendSuccess(res, "Order not found", {
      requestId: res.locals.requestId,
      order: null,
    }, 404);
  }

  return sendSuccess(res, "Order fetched", {
    requestId: res.locals.requestId,
    order: stripSortKeys(order),
  });
});

router.get("/orders", async (req: Request, res: Response) => {
  const query = orderQuerySchema.parse(req.query);
  const cursor = decodeCursor(query.cursor, orderListCursor);
  const filter: Record<string, unknown> = {};

  if (query.makerLockHash) filter.ownerLockHash = query.makerLockHash;
  if (query.xudtTypeHash) filter.xudtTypeHash = query.xudtTypeHash;
  if (query.direction) filter.direction = query.direction;
  if (query.status) filter.status = query.status;

  if (cursor) {
    const createdAt = new Date(cursor.c);
    filter.$or = [
      { createdAt: { $lt: createdAt } },
      { createdAt, _id: { $gt: cursor.i } },
    ];
  }

  const rows = await OrderModel.find(filter)
    .sort({ createdAt: -1, _id: 1 })
    .limit(query.limit + 1)
    .lean();

  const page = rows.slice(0, query.limit);
  const last = page[page.length - 1];
  const nextCursor = rows.length > query.limit && last
    ? encodeCursor({ c: last.createdAt.getTime(), i: last._id })
    : undefined;

  return sendSuccess(res, "Orders fetched", {
    requestId: res.locals.requestId,
    items: page.map(stripSortKeys),
    nextCursor,
    limit: query.limit,
  });
});

router.get("/trades", async (req: Request, res: Response) => {
  const query = tradesQuerySchema.parse(req.query);
  const cursor = decodeCursor(query.cursor, tradeCursor);

  const filter: Record<string, unknown> = { status: { $ne: "REVERTED" } };
  if (query.xudtTypeHash) filter.xudtTypeHash = query.xudtTypeHash;
  if (cursor) {
    filter.$or = [
      { blockNum: { $lt: cursor.b } },
      { blockNum: cursor.b, _id: { $gt: cursor.i } },
    ];
  }

  const rows = await TradeModel.find(filter)
    .sort({ blockNum: -1, _id: 1 })
    .limit(query.limit + 1)
    .lean();

  const page = rows.slice(0, query.limit);
  const last = page[page.length - 1];
  const nextCursor = rows.length > query.limit && last
    ? encodeCursor({ b: last.blockNum ?? 0, i: last._id })
    : undefined;

  return sendSuccess(res, "Trades fetched", {
    requestId: res.locals.requestId,
    items: page.map(stripSortKeys),
    nextCursor,
    limit: query.limit,
  });
});

export default router;
