import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { ccc } from "@ckb-ccc/connector-react";
import { useWallet } from "./WalletContext.jsx";
import { useToast } from "./ToastContext.jsx";
import { marketApi, subscribe } from "../services/api/index.js";
import { toOrderRow } from "../utils/orders.js";
import { usePendingOrders } from "../hooks/usePendingOrders.js";
import { useClosedOrdersVersion } from "../hooks/useClosedOrders.js";
import { closedStatus, markClosed, markTradesFilled, outPointKey } from "../services/closedOrders.js";

const MarketContext = createContext(null);

const DAY_MS = 24 * 60 * 60 * 1000;
const TRADE_HISTORY = 200;
const PENDING_POLL_MS = 10_000;
/** Backend statuses for an order the bot has paired and is settling. */
const IN_FLIGHT = ["RESERVED", "PENDING", "SETTLEMENT_SUBMITTED"];
const HELD_RECHECK_MS = 15_000;
const HELD_MAX_AGE_MS = 30 * 60 * 1000;

/** CKB per whole token for a confirmed trade (`price` is the flat total in shannons). */
function tradeRow(trade, decimals) {
  const amount = Number(ccc.fixedPointToString(BigInt(trade.tokenAmount), decimals));
  const total = Number(ccc.fixedPointToString(BigInt(trade.price)));
  return { price: amount ? total / amount : 0, amount, total, time: new Date(trade.createdAt) };
}

function deriveStats(trades, now) {
  if (!trades.length) return null;
  const last = trades[0];
  const cutoff = now - DAY_MS;
  const day = trades.filter((t) => t.time.getTime() >= cutoff);
  // Reference for 24h change: the last trade before the window, else the window's first trade.
  const ref = trades.find((t) => t.time.getTime() < cutoff) ?? day[day.length - 1] ?? last;
  const change = last.price - ref.price;

  return {
    lastPrice: last.price,
    lastTradeAt: last.time,
    change,
    changePct: ref.price ? (change / ref.price) * 100 : 0,
    high: day.length ? Math.max(...day.map((t) => t.price)) : null,
    low: day.length ? Math.min(...day.map((t) => t.price)) : null,
    volume: day.reduce((s, t) => s + t.amount, 0),
    volumeCkb: day.reduce((s, t) => s + t.total, 0),
    tradeCount: day.length,
  };
}

function withCumulative(rows) {
  let amount = 0;
  let total = 0;
  return rows.map((r) => ({ ...r, cumAmount: (amount += r.amount), cumTotal: (total += r.total) }));
}

/**
 * Live market data for the configured token from the ckb-dex backend:
 * the LIVE order book and confirmed trades (REST snapshot, then realtime
 * updates), plus stats derived from them. `status` is one of
 * unconfigured | loading | live | offline. The connected wallet's own
 * submitted-but-unindexed orders are listed in the book (flagged `pending`)
 * so placing an order shows up at once; they don't count toward best bid/ask.
 *
 * Fills are shown at one moment for the whole UI. The backend drops a paired
 * order from its LIVE book as soon as the settlement is sent, but only marks
 * it filled once the settlement is confirmed. Orders that leave the LIVE book
 * are therefore held here (flagged `settling`) until the closed-orders store
 * records them as filled or cancelled, the same signal Open orders and the
 * "Order filled" notice use.
 */
export function MarketProvider({ children }) {
  const { token, lockHash } = useWallet();
  const { notifyError } = useToast();
  const pending = usePendingOrders(lockHash);
  const [book, setBook] = useState(null);
  const [trades, setTrades] = useState(null);
  const [status, setStatus] = useState("loading");
  const [now, setNow] = useState(() => Date.now());
  // Orders that left the LIVE book: key -> { doc, phase: "checking" | "settling", since }.
  const [held, setHeld] = useState(() => new Map());
  const prevLive = useRef(new Map());
  const closedVersion = useClosedOrdersVersion();

  const dropHeld = useCallback((key) => {
    setHeld((m) => {
      if (!m.has(key)) return m;
      const next = new Map(m);
      next.delete(key);
      return next;
    });
  }, []);

  /** Asks the backend what happened to a held order and updates its display. */
  const checkHeld = useCallback(
    (key, doc) => {
      marketApi
        .getOrder(doc.outPoint)
        .then((order) => {
          if (order && IN_FLIGHT.includes(order.status)) {
            setHeld((m) => {
              const entry = m.get(key);
              if (!entry || entry.phase === "settling") return m;
              return new Map(m).set(key, { ...entry, phase: "settling" });
            });
            return;
          }
          if (order && order.status !== "LIVE") {
            markClosed([[doc.outPoint, order.status === "FILLED" ? "FILLED" : "CANCELED"]]);
          }
          dropHeld(key);
        })
        .catch((err) => console.warn("[LucentDex] Couldn't check order status:", err.message));
    },
    [dropHeld]
  );

  /** Applies a LIVE order book snapshot, holding orders that just left it. */
  const applyBook = useCallback(
    (items) => {
      const live = new Map();
      for (const d of items) {
        const key = outPointKey(d.outPoint);
        if (key && d.status === "LIVE") live.set(key, d);
      }
      const left = [...prevLive.current].filter(([key]) => !live.has(key));
      prevLive.current = live;
      setBook(items);
      setHeld((m) => {
        const next = new Map([...m].filter(([key]) => !live.has(key)));
        for (const [key, doc] of left) {
          if (!next.has(key) && !closedStatus(doc.outPoint)) {
            next.set(key, { doc, phase: "checking", since: Date.now() });
          }
        }
        return next;
      });
      for (const [key, doc] of left) {
        if (!closedStatus(doc.outPoint)) checkHeld(key, doc);
      }
    },
    [checkHeld]
  );

  /** Applies confirmed trades; both orders of each trade are recorded as filled. */
  const applyTrades = useCallback((items) => {
    markTradesFilled(items);
    setTrades(items.slice(0, TRADE_HISTORY));
  }, []);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!token) {
      setStatus("unconfigured");
      return;
    }
    setStatus("loading");
    const ctrl = new AbortController();
    const opts = { signal: ctrl.signal };
    const xudtTypeHash = token.typeHash;

    prevLive.current = new Map();
    setHeld(new Map());
    Promise.all([
      marketApi.getOrderBook({ xudtTypeHash, limit: 200 }, opts),
      marketApi.getTrades({ xudtTypeHash, limit: TRADE_HISTORY }, opts),
      // Orders already mid-settlement when the page loads.
      ...IN_FLIGHT.map((status) => marketApi.getOrders({ xudtTypeHash, status, limit: 200 }, opts)),
    ])
      .then(([bookItems, tradeItems, ...inFlight]) => {
        applyTrades(tradeItems);
        applyBook(bookItems);
        setHeld((m) => {
          const next = new Map(m);
          for (const doc of inFlight.flat()) {
            const key = outPointKey(doc.outPoint);
            if (key && !closedStatus(doc.outPoint)) next.set(key, { doc, phase: "settling", since: Date.now() });
          }
          return next;
        });
        setStatus("live");
      })
      .catch((err) => {
        if (err.name === "AbortError") return;
        setStatus("offline");
        notifyError("Loading market data", err, { key: "market-offline", context: { xudtTypeHash } });
      });

    const onBook = (items) => {
      if (!Array.isArray(items)) return;
      applyBook(items);
      setStatus("live");
    };
    const onTrades = (items) => {
      if (!Array.isArray(items)) return;
      applyTrades(items);
      setStatus("live");
    };
    const offBook = subscribe(`market:${xudtTypeHash}:orderbook`, onBook);
    const offTrades = subscribe(`market:${xudtTypeHash}:trades`, onTrades);
    return () => {
      ctrl.abort();
      offBook();
      offTrades();
    };
  }, [token, notifyError, applyBook, applyTrades]);

  // Re-check held orders in case a realtime message was missed; give up after a while.
  useEffect(() => {
    if (!held.size) return;
    const id = setInterval(() => {
      for (const [key, entry] of held) {
        if (Date.now() - entry.since > HELD_MAX_AGE_MS) dropHeld(key);
        else checkHeld(key, entry.doc);
      }
    }, HELD_RECHECK_MS);
    return () => clearInterval(id);
  }, [held, checkHeld, dropHeld]);

  // While our own orders await indexing, re-poll the book in case realtime is down.
  useEffect(() => {
    if (!token || !pending.length) return;
    const id = setInterval(() => {
      marketApi
        .getOrderBook({ xudtTypeHash: token.typeHash, limit: 200 })
        .then(applyBook)
        .catch((err) => console.warn("[LucentDex] Order book refresh failed:", err.message));
    }, PENDING_POLL_MS);
    return () => clearInterval(id);
  }, [token, pending.length, applyBook]);

  const value = useMemo(() => {
    const decimals = token?.decimals ?? 0;
    const live = (book ?? []).filter((d) => d.status === "LIVE" && !closedStatus(d.outPoint));
    const indexed = new Set(live.map((d) => d.outPoint?.txHash));
    const ownPending = pending.filter((r) => r.xudtTypeHash === token?.typeHash && !indexed.has(r.txHash));
    // Held orders stay until the closed-orders store says otherwise; a "checking"
    // one still looks like a normal row while we ask the backend about it.
    const heldRows = [...held.values()]
      .filter(({ doc }) => !closedStatus(doc.outPoint))
      .map(({ doc, phase }) => ({ ...toOrderRow(doc, token), settling: phase === "settling" }));
    const rows = [...live.map((d) => toOrderRow(d, token)), ...heldRows, ...ownPending];
    const asks = rows.filter((r) => r.side === "Short").sort((a, b) => a.price - b.price);
    const bids = rows.filter((r) => r.side === "Long").sort((a, b) => b.price - a.price);
    const tradable = (r) => !r.pending && !r.settling;
    const bestAsk = asks.find(tradable)?.price ?? null;
    const bestBid = bids.find(tradable)?.price ?? null;
    const mid = bestAsk !== null && bestBid !== null ? (bestAsk + bestBid) / 2 : null;

    const tradeRows = (trades ?? [])
      .map((t) => tradeRow(t, decimals))
      .sort((a, b) => b.time - a.time);
    const stats = deriveStats(tradeRows, now);

    return {
      status,
      token,
      asks: withCumulative(asks),
      bids: withCumulative(bids),
      bestAsk,
      bestBid,
      mid,
      spread: bestAsk !== null && bestBid !== null ? bestAsk - bestBid : null,
      trades: tradeRows,
      stats,
      /** Where buyers and sellers last met; falls back to the book when nothing has traded. */
      marketPrice: stats?.lastPrice ?? mid ?? bestBid ?? bestAsk,
    };
    // closedVersion: recompute when an order is recorded as filled or cancelled.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book, trades, status, token, now, pending, held, closedVersion]);

  return <MarketContext.Provider value={value}>{children}</MarketContext.Provider>;
}

export function useMarket() {
  const ctx = useContext(MarketContext);
  if (!ctx) throw new Error("useMarket must be used inside <MarketProvider>");
  return ctx;
}
