import { useEffect, useMemo, useState } from "react";
import { useMarket } from "../context/MarketContext.jsx";
import { buildCandles } from "../utils/chart.js";

/** OHLC candles for `range`, built from the market's confirmed trades; re-buckets each minute. */
export function useCandles(range) {
  const { trades } = useMarket();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  return useMemo(() => buildCandles(trades, range, now), [trades, range, now]);
}
