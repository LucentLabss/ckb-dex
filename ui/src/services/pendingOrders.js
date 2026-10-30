/**
 * Orders this browser has submitted that the backend hasn't indexed yet,
 * per maker lock hash. Kept in localStorage so they survive a reload; this is
 * only a display convenience — the backend stays the source of truth, and
 * entries are dropped once indexed or after MAX_AGE_MS.
 */
const KEY = (lockHash) => `lucentdex:pending:${lockHash}`;
const MAX_AGE_MS = 30 * 60 * 1000;
const EMPTY = [];

const cache = new Map(); // lockHash -> rows (stable reference between writes)
const listeners = new Set();

function read(lockHash) {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY(lockHash)) ?? "[]");
    const cutoff = Date.now() - MAX_AGE_MS;
    return raw
      .map((r) => ({ ...r, time: new Date(r.time) }))
      .filter((r) => r.time.getTime() >= cutoff);
  } catch {
    return [];
  }
}

function write(lockHash, rows) {
  cache.set(lockHash, rows.length ? rows : EMPTY);
  try {
    if (rows.length) localStorage.setItem(KEY(lockHash), JSON.stringify(rows));
    else localStorage.removeItem(KEY(lockHash));
  } catch {
    // Storage unavailable (private mode etc.): keep the in-memory copy only.
  }
  listeners.forEach((fn) => fn());
}

export function getPending(lockHash) {
  if (!lockHash) return EMPTY;
  if (!cache.has(lockHash)) {
    const rows = read(lockHash);
    cache.set(lockHash, rows.length ? rows : EMPTY);
  }
  return cache.get(lockHash);
}

export function addPending(lockHash, row) {
  write(lockHash, [row, ...getPending(lockHash).filter((r) => r.txHash !== row.txHash)]);
}

/** Drops rows whose tx hash is in `txHashes` (e.g. now indexed by the backend). */
export function removePending(lockHash, txHashes) {
  const rows = getPending(lockHash);
  const next = rows.filter((r) => !txHashes.has(r.txHash));
  if (next.length !== rows.length) write(lockHash, next);
}

export function subscribePending(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
