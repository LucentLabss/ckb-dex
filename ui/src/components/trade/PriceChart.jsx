import { useRef, useState } from "react";
import { useElementSize } from "../../hooks/useElementSize.js";
import { createYScale, fmtAxisTime, niceTicks, paddedRange, placeholderCandles } from "../../utils/chart.js";
import { fmtNum, fmtPriceAuto } from "../../utils/format.js";

const UP = "#12d98a";
const DOWN = "#ff2d55";
const PLACEHOLDER_SLOTS = 40;
const PLACEHOLDER = placeholderCandles(PLACEHOLDER_SLOTS);

/**
 * Candlestick + volume chart for `candles` laid out on `count` time slots
 * from `start`. With no candles it draws a muted, unlabelled stand-in chart
 * behind `emptyText`, so it never reads as real prices.
 */
export default function PriceChart({ candles: data, start: dataStart, bucket: dataBucket, count, lastPrice: dataLast, symbol, emptyText }) {
  const plotRef = useRef(null);
  const { width, height } = useElementSize(plotRef);
  const [hover, setHover] = useState(null);

  const isPlaceholder = !data.length;
  const candles = isPlaceholder ? PLACEHOLDER : data;
  const start = isPlaceholder ? 0 : dataStart;
  const bucket = isPlaceholder ? 1 : dataBucket;
  const lastPrice = isPlaceholder ? null : dataLast;

  const volH = Math.round(height * 0.18);
  const H = Math.max(0, height - volH - 6);
  const slots = Math.max(1, isPlaceholder ? PLACEHOLDER_SLOTS : count ?? candles.length);
  const step = width / slots;
  const bodyW = Math.max(1.5, Math.min(14, step * 0.65));
  const xOf = (c) => ((c.time - start) / bucket) * step + step / 2;

  const [lo, hi] = paddedRange(Math.min(...candles.map((c) => c.l)), Math.max(...candles.map((c) => c.h)));
  const y = createYScale(lo, hi, H);
  const ticks = niceTicks(lo, hi, 4).filter((t) => t >= lo && t <= hi);
  const maxVol = Math.max(1, ...candles.map((c) => c.v));
  const pct = (price) => `${(y(price) / (height || 1)) * 100}%`;

  const xTickEvery = Math.max(1, Math.ceil(slots / Math.max(2, Math.floor(width / 90))));
  const xTicks = Array.from({ length: slots }, (_, i) => i).filter((i) => i % xTickEvery === 0);

  const onMove = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const slot = Math.floor((e.clientX - rect.left) / step);
    setHover(candles.find((c) => Math.round((c.time - start) / bucket) === slot) ?? null);
  };

  return (
    <div className="chart-wrap">
      {hover && (
        <div className="chart-tip">
          {fmtAxisTime(hover.time, bucket)} · O {fmtPriceAuto(hover.o)} H {fmtPriceAuto(hover.h)} L{" "}
          {fmtPriceAuto(hover.l)} C {fmtPriceAuto(hover.c)} · Vol {fmtNum(hover.v, 2)} {symbol}
        </div>
      )}
      <div
        className={`plot ${isPlaceholder ? "placeholder" : ""}`}
        ref={plotRef}
        onMouseMove={isPlaceholder ? undefined : onMove}
        onMouseLeave={() => setHover(null)}
        aria-hidden={isPlaceholder || undefined}
      >
        {width > 0 && height > 0 && (
          <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="chart-svg">
            {ticks.map((p) => (
              <line key={p} x1="0" x2={width} y1={y(p)} y2={y(p)} className="gridline" />
            ))}
            {lastPrice !== null && (
              <line x1="0" x2={width} y1={y(lastPrice)} y2={y(lastPrice)} className="lastline" />
            )}
            {candles.map((c) => {
              const color = isPlaceholder ? "#4f6a9e" : c.c >= c.o ? UP : DOWN;
              const x = xOf(c);
              const vh = (c.v / maxVol) * (volH - 2);
              const active = hover === c;
              return (
                <g key={c.time} opacity={hover && !active ? 0.55 : 1}>
                  <line x1={x} x2={x} y1={y(c.h)} y2={y(c.l)} stroke={color} />
                  <rect
                    x={x - bodyW / 2}
                    width={bodyW}
                    y={y(Math.max(c.o, c.c))}
                    height={Math.max(1, Math.abs(y(c.o) - y(c.c)))}
                    fill={color}
                  />
                  {c.v > 0 && (
                    <rect x={x - bodyW / 2} width={bodyW} y={height - vh} height={vh} fill={color} opacity="0.45" />
                  )}
                </g>
              );
            })}
          </svg>
        )}
      </div>
      {isPlaceholder && <div className="chart-note">{emptyText}</div>}
      <div className="y-axis">
        {!isPlaceholder &&
          ticks
            .filter((p) => lastPrice === null || Math.abs(y(p) - y(lastPrice)) >= 20)
            .map((p) => (
              <span key={p} style={{ top: pct(p) }}>
                {fmtPriceAuto(p)}
              </span>
            ))}
        {lastPrice !== null && (
          <span className="last-tag" style={{ top: pct(lastPrice) }}>
            {fmtPriceAuto(lastPrice)}
          </span>
        )}
      </div>
      <div className="x-axis">
        {!isPlaceholder &&
          xTicks.map((i) => (
            <span key={i} style={{ left: `${((i + 0.5) / slots) * 100}%` }}>
              {fmtAxisTime(start + i * bucket, bucket)}
            </span>
          ))}
      </div>
    </div>
  );
}
