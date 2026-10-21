import { useMemo, useState } from "react";

export type DepthPoint = { price: number; amount: number; cumulative?: number };

type PlotPoint = { price: number; cumulative: number };

const WIDTH = 600;
const HEIGHT = 190;
const PAD_TOP = 18;
const PAD_BOTTOM = 26;
const PAD_X = 6;
const PLOT_HEIGHT = HEIGHT - PAD_TOP - PAD_BOTTOM;
// Horizontal reference lines as a fraction of the plot height, low-to-high - gives the
// cumulative-amount axis an actual scale to read against, like the endlabels alone didn't.
const GRIDLINE_FRACTIONS = [0.25, 0.5, 0.75];

/**
 * Cumulative order-book depth, bids and asks meeting at the spread. Renders nothing (the
 * caller shows its own empty-state text) when both sides are empty - a chart with no data
 * on either axis has no honest way to draw itself.
 */
export function DepthChart({
  bids,
  asks,
  midPrice,
}: {
  /** Best (highest) bid first, cumulative increasing away from the best - i.e. bidRows as
   *  already computed for the order-book table. */
  bids: DepthPoint[];
  /** Worst (highest) ask first, cumulative decreasing toward the best - i.e. askRows as
   *  already computed for the order-book table. */
  asks: DepthPoint[];
  midPrice: number;
}) {
  const [hover, setHover] = useState<{ x: number; point: PlotPoint; side: "bid" | "ask" } | null>(
    null,
  );

  const bidsAscending = useMemo<PlotPoint[]>(
    () => [...bids].reverse().map((row) => ({ price: row.price, cumulative: row.cumulative ?? row.amount })),
    [bids],
  );
  const asksAscending = useMemo<PlotPoint[]>(
    () => [...asks].reverse().map((row) => ({ price: row.price, cumulative: row.cumulative ?? row.amount })),
    [asks],
  );

  if (bidsAscending.length === 0 && asksAscending.length === 0) return null;

  const minPrice = bidsAscending[0]?.price ?? midPrice;
  const maxPrice = asksAscending[asksAscending.length - 1]?.price ?? midPrice;
  const priceSpan = Math.max(maxPrice - minPrice, 1e-9);
  const maxCumulative = Math.max(
    bidsAscending[0]?.cumulative ?? 0,
    asksAscending[asksAscending.length - 1]?.cumulative ?? 0,
    1,
  );

  function toX(price: number): number {
    return PAD_X + ((price - minPrice) / priceSpan) * (WIDTH - PAD_X * 2);
  }
  function toY(cumulative: number): number {
    return PAD_TOP + PLOT_HEIGHT - (cumulative / maxCumulative) * PLOT_HEIGHT;
  }

  // A single resting order on one side has nothing to step against - draw it as a small
  // block around its price rather than a zero-width line that would otherwise be invisible.
  const soloHalfWidth = priceSpan * 0.02;

  function buildStepPath(points: PlotPoint[], direction: "rising" | "falling"): string {
    if (points.length === 0) return "";
    if (points.length === 1) {
      const { price, cumulative } = points[0];
      const x1 = toX(price - soloHalfWidth);
      const x2 = toX(price + soloHalfWidth);
      const y = toY(cumulative);
      const baseline = toY(0);
      return `M ${x1} ${baseline} L ${x1} ${y} L ${x2} ${y} L ${x2} ${baseline} Z`;
    }

    const baseline = toY(0);
    const first = points[0];
    let d = `M ${toX(first.price)} ${baseline} L ${toX(first.price)} ${toY(first.cumulative)}`;

    for (let i = 1; i < points.length; i++) {
      const prev = points[i - 1];
      const curr = points[i];
      // Step to the next price at the previous cumulative, then rise/fall to the new one -
      // a discrete order book is a staircase, never a smooth interpolation between levels.
      d += ` L ${toX(curr.price)} ${toY(prev.cumulative)} L ${toX(curr.price)} ${toY(curr.cumulative)}`;
    }

    const last = points[points.length - 1];
    d += ` L ${toX(last.price)} ${baseline} Z`;
    void direction;
    return d;
  }

  const bidPath = buildStepPath(bidsAscending, "falling");
  const askPath = buildStepPath(asksAscending, "rising");
  const midX = toX(midPrice);

  const allPoints: { x: number; point: PlotPoint; side: "bid" | "ask" }[] = [
    ...bidsAscending.map((point) => ({ x: toX(point.price), point, side: "bid" as const })),
    ...asksAscending.map((point) => ({ x: toX(point.price), point, side: "ask" as const })),
  ];

  function handleMove(event: React.MouseEvent<SVGRectElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const pointerX = ((event.clientX - rect.left) / rect.width) * WIDTH;
    let nearest = allPoints[0];
    let bestDist = Math.abs(allPoints[0].x - pointerX);
    for (const candidate of allPoints) {
      const dist = Math.abs(candidate.x - pointerX);
      if (dist < bestDist) {
        nearest = candidate;
        bestDist = dist;
      }
    }
    setHover(nearest);
  }

  const leftmostCumulative = bidsAscending[0]?.cumulative;
  const rightmostCumulative = asksAscending[asksAscending.length - 1]?.cumulative;

  return (
    <div className="depth-chart">
      <div className="depth-chart-legend">
        <span className="depth-chart-legend-item">
          <span className="depth-chart-swatch bid" /> Bids
        </span>
        <span className="depth-chart-legend-item">
          <span className="depth-chart-swatch ask" /> Asks
        </span>
      </div>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="depth-chart-svg"
        role="img"
        aria-label="Cumulative order book depth for bids and asks"
        preserveAspectRatio="none"
      >
        {GRIDLINE_FRACTIONS.map((fraction) => {
          const y = toY(maxCumulative * fraction);
          return (
            <g key={fraction}>
              <line x1={PAD_X} y1={y} x2={WIDTH - PAD_X} y2={y} className="depth-chart-gridline" />
              <text x={PAD_X + 4} y={y - 4} className="depth-chart-gridlabel">
                {formatDepthAmount(maxCumulative * fraction)}
              </text>
            </g>
          );
        })}

        <line
          x1={PAD_X}
          y1={toY(0)}
          x2={WIDTH - PAD_X}
          y2={toY(0)}
          className="depth-chart-baseline"
        />
        <line x1={midX} y1={PAD_TOP} x2={midX} y2={toY(0)} className="depth-chart-mid" />
        <text x={midX} y={PAD_TOP - 6} textAnchor="middle" className="depth-chart-midlabel">
          {fmtDepthPrice(midPrice)}
        </text>

        {bidPath ? <path d={bidPath} className="depth-chart-area bid" /> : null}
        {bidPath ? <path d={bidPath} className="depth-chart-line bid" /> : null}
        {askPath ? <path d={askPath} className="depth-chart-area ask" /> : null}
        {askPath ? <path d={askPath} className="depth-chart-line ask" /> : null}

        {leftmostCumulative !== undefined ? (
          <text x={PAD_X + 4} y={toY(leftmostCumulative) - 6} className="depth-chart-endlabel">
            {formatDepthAmount(leftmostCumulative)}
          </text>
        ) : null}
        {rightmostCumulative !== undefined ? (
          <text
            x={WIDTH - PAD_X - 4}
            y={toY(rightmostCumulative) - 6}
            textAnchor="end"
            className="depth-chart-endlabel"
          >
            {formatDepthAmount(rightmostCumulative)}
          </text>
        ) : null}

        {hover ? (
          <line
            x1={hover.x}
            y1={PAD_TOP}
            x2={hover.x}
            y2={toY(0)}
            className="depth-chart-crosshair"
          />
        ) : null}

        {/* Transparent hit layer on top, sized to the full plot - a depth chart's "marks" are
            continuous areas, so hover tracks pointer X rather than per-mark hit targets. */}
        <rect
          x={0}
          y={0}
          width={WIDTH}
          height={HEIGHT}
          fill="transparent"
          onMouseMove={handleMove}
          onMouseLeave={() => setHover(null)}
        />
      </svg>

      {hover ? (
        <div
          className="depth-chart-tooltip"
          style={{ left: `${(hover.x / WIDTH) * 100}%` }}
        >
          <div className="depth-chart-tooltip-value">{formatDepthAmount(hover.point.cumulative)} TOKEN</div>
          <div className={`depth-chart-tooltip-label ${hover.side}`}>
            <span className={`depth-chart-swatch ${hover.side}`} />
            {hover.side === "bid" ? "Bids" : "Asks"} up to {fmtDepthPrice(hover.point.price)} CKB
          </div>
        </div>
      ) : null}
    </div>
  );
}

function formatDepthAmount(value: number): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function fmtDepthPrice(value: number): string {
  return value.toFixed(6);
}
