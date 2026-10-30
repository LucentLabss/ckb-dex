import { get } from "./http.js";

/** Read-only market endpoints exposed by ckb-dex/backend (src/routes/market.ts). */

export const getMarkets = (opts) => get("/markets", {}, opts).then((d) => d.markets);

export const getOrderBook = ({ xudtTypeHash, direction, limit = 25 }, opts) =>
  get("/order-book", { xudtTypeHash, direction, limit }, opts).then((d) => d.items);

export const getOrders = ({ makerLockHash, xudtTypeHash, status, limit = 100 }, opts) =>
  get("/orders", { makerLockHash, xudtTypeHash, status, limit }, opts).then((d) => d.items);

export const getTrades = ({ xudtTypeHash, limit = 25 }, opts) =>
  get("/trades", { xudtTypeHash, limit }, opts).then((d) => d.items);

/** One order by out point, or null if the backend doesn't know it. */
export const getOrder = ({ txHash, index }, opts) =>
  get(`/orders/${txHash}/${BigInt(index ?? 0)}`, {}, opts).then(
    (d) => d.order ?? null,
    (err) => {
      if (err.status === 404) return null;
      throw err;
    }
  );
