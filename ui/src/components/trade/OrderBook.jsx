import LiveBadge from "../common/LiveBadge.jsx";
import { useMarket } from "../../context/MarketContext.jsx";
import { fmtNum, fmtPriceAuto } from "../../utils/format.js";

const DEPTH = 8;

const EMPTY_TEXT = {
  loading: "Loading order book…",
  offline: "Order book unavailable — can't reach the server",
  unconfigured: "No market token configured",
};

function Row({ row, side, maxCum, onPick }) {
  const depth = maxCum ? Math.max(3, (row.cumAmount / maxCum) * 100) : 0;
  return (
    <button
      type="button"
      className={`ob-row ${side} ${row.pending || row.settling ? "pending" : ""}`}
      onClick={() => !row.settling && onPick?.(row.price)}
      title={
        row.settling
          ? "Matched — settling on-chain; leaves the book when the trade confirms"
          : row.pending
            ? "Your order — waiting for on-chain confirmation"
            : "Use this price"
      }
    >
      <i style={{ width: `${depth}%` }} />
      <span>
        {fmtPriceAuto(row.price)}
        {row.pending && <em className="ob-pending">pending</em>}
        {row.settling && <em className="ob-pending">settling</em>}
      </span>
      <span>{fmtNum(row.amount, 4)}</span>
      <span>{fmtNum(row.cumTotal, 2)}</span>
    </button>
  );
}

/** Live LIVE-status orders for the market, grouped by side with cumulative depth. */
export default function OrderBook({ onPickPrice }) {
  const { status, token, asks, bids, mid, spread, stats } = useMarket();
  const shownAsks = asks.slice(0, DEPTH);
  const shownBids = bids.slice(0, DEPTH);
  const maxCum = Math.max(0, shownAsks.at(-1)?.cumAmount ?? 0, shownBids.at(-1)?.cumAmount ?? 0);
  const symbol = token?.symbol ?? "TOKEN";
  const empty = !shownAsks.length && !shownBids.length;
  const centre = stats?.lastPrice ?? mid;

  return (
    <section className="card orderbook">
      <div className="card-h">
        <b>Order book {status === "live" && <LiveBadge />}</b>
        <span>{asks.length + bids.length} orders</span>
      </div>
      <div className="ob-head">
        <span>Price (CKB)</span>
        <span>Amount ({symbol})</span>
        <span>Total (CKB)</span>
      </div>

      {status !== "live" ? (
        <div className="ob-empty">{EMPTY_TEXT[status]}</div>
      ) : empty ? (
        <div className="ob-empty">No open orders yet — be the first to place one.</div>
      ) : (
        <>
          {/* Asks list from the highest shown price down to the best ask. */}
          {[...shownAsks].reverse().map((r) => (
            <Row key={r.id} row={r} side="ask" maxCum={maxCum} onPick={onPickPrice} />
          ))}
          <div className="mid">
            <b className={stats && stats.change < 0 ? "down" : "up"}>{fmtPriceAuto(centre)}</b>
            <small>
              {spread !== null
                ? `Spread ${fmtPriceAuto(spread)} (${((spread / mid) * 100).toFixed(2)}%)`
                : shownAsks.length
                  ? "No bids"
                  : "No asks"}
            </small>
          </div>
          {shownBids.map((r) => (
            <Row key={r.id} row={r} side="bid" maxCum={maxCum} onPick={onPickPrice} />
          ))}
        </>
      )}
    </section>
  );
}
