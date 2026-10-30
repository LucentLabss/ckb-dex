/**
 * Orders known to be closed (filled or cancelled), keyed by out point. The
 * backend reports a fill on several channels (trades, your orders, the order
 * book) whose messages arrive separately; whichever arrives first records the
 * order here, and every view reads this one store, so the order book, Open
 * orders and the "Order filled" notice all change in the same render.
 */
const closed = new Map(); // key -> "FILLED" | "CANCELED"
const listeners = new Set();
let version = 0;

/** `${txHash}:${index}` with the index normalised ("0x0", "0" and 0 all match). */
export function outPointKey(outPoint) {
  if (!outPoint?.txHash) return null;
  try {
    return `${outPoint.txHash.toLowerCase()}:${BigInt(outPoint.index ?? 0)}`;
  } catch {
    return null;
  }
}

/** Records closed orders: entries are [outPoint, "FILLED" | "CANCELED"]. */
export function markClosed(entries) {
  let changed = false;
  for (const [outPoint, status] of entries) {
    const key = outPointKey(outPoint);
    if (key && !closed.has(key)) {
      closed.set(key, status);
      changed = true;
    }
  }
  if (changed) {
    version++;
    listeners.forEach((fn) => fn());
  }
}

/** Closed status for an out point, or undefined while it's still open as far as we know. */
export const closedStatus = (outPoint) => closed.get(outPointKey(outPoint));

/** Changes whenever the store does; for useSyncExternalStore. */
export const closedVersion = () => version;

export function subscribeClosed(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Both orders a confirmed trade settled count as filled. */
export function markTradesFilled(trades) {
  markClosed(
    trades.flatMap((t) => [
      [t.buyOrderOutPoint, "FILLED"],
      [t.sellOrderOutPoint, "FILLED"],
    ])
  );
}
