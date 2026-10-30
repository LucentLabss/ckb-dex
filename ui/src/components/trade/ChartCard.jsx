import { useState } from "react";
import PriceChart from "./PriceChart.jsx";
import SegmentedControl from "../common/SegmentedControl.jsx";
import { useMarket } from "../../context/MarketContext.jsx";
import { useCandles } from "../../hooks/useCandles.js";
import { RANGES } from "../../utils/chart.js";
import { fmtPriceAuto, signed } from "../../utils/format.js";

const EMPTY_TEXT = {
  loading: "Loading price history…",
  offline: "Live prices unavailable right now",
  unconfigured: "No market selected",
  live: "No trades yet — the chart starts with the first filled order",
};

/** Price chart built from the market's confirmed trades. */
export default function ChartCard() {
  const [range, setRange] = useState("1D");
  const { status, token, stats } = useMarket();
  const { candles, start, bucket, count } = useCandles(range);
  const symbol = token?.symbol ?? "xUDT";

  const first = candles[0];
  const last = candles[candles.length - 1];
  const change = first && last ? last.c - first.o : 0;
  const tone = change > 0 ? "up" : change < 0 ? "down" : "";

  return (
    <section className="card chartcard">
      <div className="tabs">
        <button className="on">Chart</button>
        <SegmentedControl className="right" options={Object.keys(RANGES)} value={range} onChange={setRange} />
      </div>
      <div className="ohlc">
        <b>
          {symbol}-CKB · {range}
        </b>{" "}
        {first && last ? (
          <span>
            O<em>{fmtPriceAuto(first.o)}</em> H<em>{fmtPriceAuto(Math.max(...candles.map((c) => c.h)))}</em> L
            <em>{fmtPriceAuto(Math.min(...candles.map((c) => c.l)))}</em> C<em>{fmtPriceAuto(last.c)}</em>
            <em className={tone}>
              {signed(change)} ({signed(first.o ? (change / first.o) * 100 : 0)}%)
            </em>
          </span>
        ) : (
          <span className="mut">—</span>
        )}
      </div>
      <PriceChart
        candles={candles}
        start={start}
        bucket={bucket}
        count={count}
        lastPrice={stats?.lastPrice ?? null}
        symbol={symbol}
        emptyText={EMPTY_TEXT[status]}
      />
    </section>
  );
}
