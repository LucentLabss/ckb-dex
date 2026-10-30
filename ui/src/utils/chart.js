const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Range → window length and candle bucket size. ALL is sized from the data. */
export const RANGES = {
  "1D": { span: DAY, bucket: HOUR },
  "7D": { span: 7 * DAY, bucket: 6 * HOUR },
  "1M": { span: 30 * DAY, bucket: DAY },
  ALL: null,
};

/**
 * Buckets trades ({ price, amount, time }) into OHLC candles for `range`.
 * Buckets with no trades carry the previous close as a flat zero-volume
 * candle, so the time axis stays even; nothing is drawn before the first
 * known price.
 */
export function buildCandles(trades, range, now = Date.now()) {
  if (!trades.length) return { candles: [], start: now, bucket: HOUR };

  const asc = [...trades].sort((a, b) => a.time - b.time);
  let { span, bucket } = RANGES[range] ?? {};
  if (!span) {
    span = Math.max(HOUR, now - asc[0].time.getTime());
    bucket = Math.max(HOUR, Math.ceil(span / 40 / HOUR) * HOUR);
  }
  const count = Math.ceil(span / bucket);
  const start = Math.floor((now - count * bucket) / bucket) * bucket + bucket;

  // Last price before the window seeds the first candles.
  let prevClose = null;
  for (const t of asc) {
    if (t.time.getTime() < start) prevClose = t.price;
    else break;
  }

  const buckets = Array.from({ length: count }, () => []);
  for (const t of asc) {
    const i = Math.floor((t.time.getTime() - start) / bucket);
    if (i >= 0 && i < count) buckets[i].push(t);
  }

  const candles = [];
  buckets.forEach((items, i) => {
    const time = start + i * bucket;
    if (!items.length) {
      if (prevClose !== null) candles.push({ time, o: prevClose, h: prevClose, l: prevClose, c: prevClose, v: 0 });
      return;
    }
    const prices = items.map((t) => t.price);
    const o = prevClose ?? prices[0];
    const c = prices[prices.length - 1];
    candles.push({
      time,
      o,
      c,
      h: Math.max(o, ...prices),
      l: Math.min(o, ...prices),
      v: items.reduce((s, t) => s + t.amount, 0),
      trades: items.length,
    });
    prevClose = c;
  });

  return { candles, start, bucket, count };
}

const MAX_TICKS = 20;

/**
 * Pads a price range for the y-axis. A range that is effectively flat (e.g.
 * equal prices that differ only by float rounding, 0.00814 vs
 * 0.008140000000000001) gets ±2% of the price instead.
 */
export function paddedRange(lo, hi) {
  const flat = hi - lo <= Math.abs(hi) * 1e-9;
  const span = flat ? Math.abs(hi) * 0.02 || 1 : hi - lo;
  return [Math.max(0, lo - span * 0.12), hi + span * 0.12];
}

/** ~`n` evenly spaced, human-friendly ticks covering [lo, hi]. */
export function niceTicks(lo, hi, n = 4) {
  const span = hi - lo || Math.abs(hi) || 1;
  const raw = span / n;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const ticks = [];
  if (!(step > 0) || !Number.isFinite(lo) || !Number.isFinite(hi)) return ticks;
  // Bounded loop: if `step` is below float precision at this magnitude, `v += step`
  // would never advance and the page would freeze.
  for (let i = 0, v = Math.ceil(lo / step) * step; i < MAX_TICKS && v <= hi + step * 1e-9; i++) {
    ticks.push(Number(v.toPrecision(12)));
    const next = v + step;
    if (next === v) break;
    v = next;
  }
  return ticks;
}

export const createYScale = (lo, hi, height) => (price) => ((hi - price) / (hi - lo || 1)) * height;

export function fmtAxisTime(ms, bucket) {
  const d = new Date(ms);
  if (bucket < DAY) {
    return bucket <= HOUR
      ? d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
      : d.toLocaleDateString("en-GB", { day: "numeric", month: "short" }) + ` ${String(d.getHours()).padStart(2, "0")}h`;
  }
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

/**
 * Decorative stand-in candles for when there's no price history to show.
 * Seeded, so the shape is stable; values are unitless and never labelled.
 */
export function placeholderCandles(count = 40) {
  let seed = 11;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const out = [];
  let prev = 100;
  for (let i = 0; i < count; i++) {
    const c = prev + (rnd() - 0.47) * 6;
    out.push({ time: i, o: prev, c, h: Math.max(prev, c) + rnd() * 2.5, l: Math.min(prev, c) - rnd() * 2.5, v: 20 + rnd() * 60 });
    prev = c;
  }
  return out;
}
