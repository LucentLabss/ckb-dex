// Verifies database-side keyset pagination, input bounds, rate limiting and WebSocket limits.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { WebSocket } from "ws";

import { createExpressServer } from "./app.js";
import { backfillSortKeys } from "./services/backfill.js";
import { RealtimeBroadcaster } from "./services/realtime.js";
import OrderModel from "./models/order.js";
import TradeModel from "./models/trade.js";
import type { Config } from "./types/index.js";

const MARKET = `0x${"33".repeat(32)}`;
const OTHER_MARKET = `0x${"34".repeat(32)}`;
const MAKER = `0x${"44".repeat(32)}`;

const config: Config = {
  mongodbUrl: "mongodb://127.0.0.1:27017/ckb-dex",
  ckbRpcUrl: "http://127.0.0.1:8114",
  ckbNetwork: "devnet",
  enviroment: "development",
  dexOrderLockScript: { codeHash: `0x${"11".repeat(32)}`, hashType: "type", args: "0x" },
  internalBotToken: "t".repeat(40),
  confirmationDepth: 10,
  port: 0,
  apiVersion: 1,
};

let mongod: MongoMemoryServer;
let server: Server;
let base: string;
let wsBase: string;
const realtime = RealtimeBroadcaster.getInstance();

const script = { codeHash: `0x${"11".repeat(32)}`, hashType: "type", args: "0x" };
async function seedOrder(n: number, direction: "ASK" | "BID", price: string, block: string, market = MARKET) {
  await OrderModel.collection.insertOne({
    _id: `order-${n}` as any,
    outPoint: { txHash: `0x${n.toString(16).padStart(64, "0")}`, index: "0" },
    lockScript: script, cellData: "0x", capacity: "1", ownerLock: script, ownerLockHash: MAKER,
    direction, pricePerToken: price, remainingAmount: "1", tokenPair: `${market}:CKB`, xudtTypeHash: market,
    blockNumber: block, txIndex: "0", status: "LIVE",
    createdAt: new Date(1_700_000_000_000 + n * 1000), updatedAt: new Date(),
  });
}

async function get(path: string) {
  const response = await fetch(`${base}${path}`);
  return { status: response.status, body: (await response.json()) as any };
}

async function pageAll(path: string, size: number) {
  const items: any[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 20; guard++) {
    const { status, body } = await get(`${path}&limit=${size}${cursor ? `&cursor=${cursor}` : ""}`);
    assert.equal(status, 200);
    items.push(...body.data.items);
    cursor = body.data.nextCursor;
    if (!cursor) return items;
  }
  throw new Error("pagination did not terminate");
}

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("market-pagination"));
  await Promise.all([OrderModel.init(), TradeModel.init()]);

  // Prices/blocks chosen so lexicographic string order differs from numeric order.
  const asks = ["9", "10", "100", "2", "10", "1000", "20"];
  for (const [i, price] of asks.entries()) await seedOrder(i + 1, "ASK", price, String(i === 4 ? 9 : 100 + i));
  for (const [i, price] of ["5", "50", "500", "7"].entries()) await seedOrder(20 + i, "BID", price, "5");
  await seedOrder(40, "ASK", "1", "1", OTHER_MARKET);

  for (const [i, block] of ["9", "10", "100", "11", "2"].entries()) {
    await TradeModel.collection.insertOne({
      _id: `trade-${i}` as any, settlementTxHash: `trade-${i}`,
      buyOrderOutPoint: { txHash: "0xb", index: "0" }, sellOrderOutPoint: { txHash: "0xa", index: "0" },
      buyerLockHash: MAKER, sellerLockHash: MAKER, xudtTypeHash: MARKET, tokenAmount: "1", price: "1", paidCapacity: "1",
      blockNumber: block, blockHash: "0x1", confirmedAtBlock: block, lastEventId: "e", status: "CONFIRMED",
      createdAt: new Date(), updatedAt: new Date(),
    });
  }
  await TradeModel.collection.insertOne({
    _id: "reverted" as any, settlementTxHash: "reverted", buyOrderOutPoint: { txHash: "0xb", index: "0" },
    sellOrderOutPoint: { txHash: "0xa", index: "0" }, buyerLockHash: MAKER, sellerLockHash: MAKER, xudtTypeHash: MARKET,
    tokenAmount: "1", price: "1", paidCapacity: "1", blockNumber: "999", blockHash: "0x1", confirmedAtBlock: "999",
    lastEventId: "e", status: "REVERTED", createdAt: new Date(), updatedAt: new Date(),
  });

  // Documents written before the numeric sort keys existed are upgraded on startup.
  const filled = await backfillSortKeys();
  assert.equal(filled.orders, 12);
  assert.equal(filled.trades, 6);

  const app = createExpressServer(config, { isReady: () => true });
  server = app.listen(0);
  realtime.attach(server, {
    maxPayloadBytes: 1024, maxChannelsPerMessage: 3, maxChannelsPerSocket: 4, maxConnectionsPerIp: 3, snapshotLimit: 2,
  });
  const { port } = server.address() as { port: number };
  base = `http://127.0.0.1:${port}/api/v1`;
  wsBase = `ws://127.0.0.1:${port}`;
});

after(async () => {
  await realtime.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await mongoose.disconnect();
  await mongod.stop();
});

test("order book pages asks by numeric price then chain order, without gaps or repeats", async () => {
  const items = await pageAll(`/order-book?xudtTypeHash=${MARKET}&direction=ASK`, 3);
  assert.deepEqual(items.map((order) => order.pricePerToken), ["2", "9", "10", "10", "20", "100", "1000"]);
  // Equal price: lower block first (order-5 was created in block 9, order-2 in block 101).
  assert.deepEqual(items.slice(2, 4).map((order) => order._id), ["order-5", "order-2"]);
  assert.equal(new Set(items.map((order) => order._id)).size, items.length);
  assert.equal(items[0].priceValue, undefined, "internal sort keys are not exposed");
});

test("order book pages bids best (highest) price first", async () => {
  const items = await pageAll(`/order-book?xudtTypeHash=${MARKET}&direction=BID`, 2);
  assert.deepEqual(items.map((order) => order.pricePerToken), ["500", "50", "7", "5"]);
});

test("the last page has no cursor and filters stay scoped to the market", async () => {
  const { body } = await get(`/order-book?xudtTypeHash=${MARKET}&direction=ASK&limit=7`);
  assert.equal(body.data.items.length, 7);
  assert.equal(body.data.nextCursor, undefined);
  const other = await get(`/order-book?xudtTypeHash=${OTHER_MARKET}`);
  assert.deepEqual(other.body.data.items.map((order: any) => order._id), ["order-40"]);
});

test("orders list newest first and pages by cursor", async () => {
  const items = await pageAll(`/orders?makerLockHash=${MAKER}`, 5);
  assert.equal(items.length, 12);
  const created = items.map((order) => new Date(order.createdAt).getTime());
  assert.deepEqual(created, [...created].sort((a, b) => b - a));
  assert.equal(new Set(items.map((order) => order._id)).size, 12);
});

test("trades page by numeric block (10 after 9), exclude reverted ones", async () => {
  const items = await pageAll(`/trades?xudtTypeHash=${MARKET}`, 2);
  assert.deepEqual(items.map((trade) => trade.blockNumber), ["100", "11", "10", "9", "2"]);
  assert.equal(items.some((trade) => trade._id === "reverted"), false);
});

test("malformed query input is a 400, not a 500", async () => {
  for (const path of [
    "/order-book?xudtTypeHash=nothex",
    "/order-book?limit=201",
    "/order-book?limit=0",
    "/order-book?limit=abc",
    "/order-book?direction=SIDEWAYS",
    "/order-book?cursor=%25%25%25",
    `/order-book?cursor=${"a".repeat(600)}`,
    "/orders?status=BOGUS",
    "/orders?makerLockHash=short",
    "/trades?cursor=e30",
    "/orders/nothex/0",
    `/orders/0x${"ab".repeat(32)}/notanumber`,
  ]) {
    assert.equal((await get(path)).status, 400, path);
  }
});

test("oversized and malformed request bodies are rejected with 4xx", async () => {
  const headers = { "content-type": "application/json", authorization: `Bearer ${"t".repeat(40)}` };
  const big = await fetch(`${base}/internal/events`, { method: "POST", headers, body: JSON.stringify({ pad: "x".repeat(200_000) }) });
  assert.equal(big.status, 413);
  const bad = await fetch(`${base}/internal/events`, { method: "POST", headers, body: "{not json" });
  assert.equal(bad.status, 400);
});

test("public reads are rate limited per client", async () => {
  const app = createExpressServer(config, { isReady: () => true });
  const limited = app.listen(0);
  const { port } = limited.address() as { port: number };
  try {
    const statuses: number[] = [];
    for (let i = 0; i < 305; i++) statuses.push((await fetch(`http://127.0.0.1:${port}/api/v1/markets`)).status);
    assert.equal(statuses.filter((status) => status === 200).length, 300);
    assert.equal(statuses.at(-1), 429);
  } finally {
    await new Promise<void>((resolve) => limited.close(() => resolve()));
  }
});

const open = (url = wsBase) => new Promise<WebSocket>((resolve, reject) => {
  const socket = new WebSocket(url);
  socket.once("open", () => resolve(socket));
  socket.once("error", reject);
});
const next = (socket: WebSocket) => new Promise<any>((resolve) => socket.once("message", (raw) => resolve(JSON.parse(raw.toString()))));
const closed = (socket: WebSocket) => new Promise<number>((resolve) => socket.once("close", (code) => resolve(code)));

test("websocket accepts valid channels and bounds snapshots", async () => {
  const socket = await open();
  const reply = next(socket);
  socket.send(JSON.stringify({ channels: [`market:${MARKET}:orderbook`] }));
  const snapshot = await reply;
  assert.equal(snapshot.type, "snapshot");
  assert.equal(snapshot.data.length, 4, "at most 2 asks + 2 bids with snapshotLimit 2");
  socket.close();
});

test("websocket rejects invalid, excessive and oversized subscriptions", async () => {
  const socket = await open();
  const send = async (payload: unknown) => {
    const reply = next(socket);
    socket.send(typeof payload === "string" ? payload : JSON.stringify(payload));
    return reply;
  };

  assert.match((await send({ channels: ["market:nope:orderbook"] })).message, /Invalid channel/);
  assert.match((await send({ channels: [`market:${MARKET}:orderbook`, "x".repeat(50)] })).message, /Invalid channel/);
  assert.match((await send({ channels: Array.from({ length: 4 }, (_, i) => `maker:0x${String(i).repeat(64)}:orders`) })).message, /At most 3 channels per message/);
  assert.match((await send("not json")).message, /Invalid websocket payload/);
  assert.match((await send({ channels: "market" })).message, /Expected channels array/);

  // Per-connection cap is 4: three subscriptions fit (one snapshot each), two more would exceed it.
  const snapshots = new Promise<void>((resolve) => {
    let seen = 0;
    const onMessage = () => { if (++seen === 3) { socket.off("message", onMessage); resolve(); } };
    socket.on("message", onMessage);
  });
  socket.send(JSON.stringify({ channels: [1, 2, 3].map((n) => `maker:0x${String(n).repeat(64)}:orders`) }));
  await snapshots;
  const over = await send({ channels: [`maker:0x${"4".repeat(64)}:orders`, `maker:0x${"5".repeat(64)}:orders`] });
  assert.match(over.message ?? "", /At most 4 channels per connection/);

  const oversized = closed(socket);
  socket.send(JSON.stringify({ channels: [], pad: "x".repeat(2_000) }));
  assert.equal(await oversized, 1009, "frames over maxPayload close the connection");
});

test("websocket caps connections per client address", async () => {
  const sockets = await Promise.all([open(), open(), open()]);
  const fourth = new WebSocket(wsBase);
  const code = await new Promise<number>((resolve) => fourth.once("close", (c) => resolve(c)));
  assert.equal(code, 1013);
  sockets.forEach((socket) => socket.close());
  await Promise.all(sockets.map((socket) => closed(socket)));

  // Slots free up once connections close.
  const again = await open();
  again.close();
});
