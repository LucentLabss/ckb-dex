import LiveBadge from "../common/LiveBadge.jsx";
import { useMarket } from "../../context/MarketContext.jsx";
import { fmtNum, fmtPriceAuto, signed } from "../../utils/format.js";

const STATUS_TEXT = {
  loading: "Loading…",
  offline: "Offline",
  unconfigured: "No market",
};

export default function PairBar() {
  const { status, token, stats, marketPrice, bestBid, bestAsk } = useMarket();
  const symbol = token?.symbol ?? "xUDT";
  const tone = !stats ? "" : stats.change > 0 ? "up" : stats.change < 0 ? "down" : "";

  return (
    <section className="card pairbar">
      <div className="coin">$</div>
      <div className="pair">
        <b>{symbol}-CKB</b>
        <small>
          {symbol} / CKB{" "}
          {status === "live" ? <LiveBadge /> : <i className="mut-badge">{STATUS_TEXT[status]}</i>}
        </small>
      </div>
      <div className="stat stat-price">
        <small title="Price of the most recent filled trade, where a buy and a sell order met">
          {stats ? "Last price (CKB)" : "Mid price (CKB)"}
        </small>
        <div>
          <b className={`big ${tone}`}>{fmtPriceAuto(marketPrice)}</b>{" "}
          {stats ? (
            <span className={tone}>
              {signed(stats.change)} {signed(stats.changePct)}%
            </span>
          ) : (
            status === "live" && <span className="mut">No trades yet</span>
          )}
        </div>
      </div>
      <div className="stat">
        <small>Best bid / ask</small>
        <b>
          <span className="up">{fmtPriceAuto(bestBid)}</span> / <span className="down">{fmtPriceAuto(bestAsk)}</span>
        </b>
      </div>
      <div className="stat">
        <small>24h High</small>
        <b>{fmtPriceAuto(stats?.high)}</b>
      </div>
      <div className="stat">
        <small>24h Low</small>
        <b>{fmtPriceAuto(stats?.low)}</b>
      </div>
      <div className="stat">
        <small>24h Volume</small>
        <b title={stats ? `${fmtNum(stats.volumeCkb, 2)} CKB across ${stats.tradeCount} trades` : undefined}>
          {stats ? `${fmtNum(stats.volume, 2)} ${symbol}` : "—"}
        </b>
      </div>
    </section>
  );
}
