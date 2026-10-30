import { useState } from "react";
import { useWallet } from "../../context/WalletContext.jsx";
import { ORDER_COLUMNS } from "../../data/mock.js";
import { fmtNum, fmtTime } from "../../utils/format.js";

function Row({ order, onCancel }) {
  return (
    <div className="thead trow">
      <span>{order.pair}</span>
      <span className={order.side === "Long" ? "up" : "down"}>
        {order.side}
      </span>
      <span>{order.type}</span>
      <span>{fmtNum(order.price)}</span>
      <span>{fmtNum(order.amount)}</span>
      <span>{fmtNum(order.total)}</span>
      <span title={order.txHash ?? undefined}>{order.status}</span>
      <span>{fmtTime(order.time)}</span>
      <span className="row-action">
        {onCancel && <OrderAction order={order} onCancel={onCancel} />}
      </span>
    </div>
  );
}

/** Cancel button, or why the order can't be cancelled right now. */
function OrderAction({ order, onCancel }) {
  if (order.cancelling) {
    return (
      <span className="row-note">
        <span className="spinner" aria-hidden="true" /> Cancelling…
      </span>
    );
  }
  if (order.cancellable) {
    return (
      <button
        type="button"
        className="cancel-btn"
        onClick={() => onCancel(order)}
        title={
          order.pending
            ? "Cancel as soon as the order is on-chain (about 15–30 s after placing it)"
            : "Cancel and get your CKB or tokens back"
        }
      >
        Cancel
      </button>
    );
  }
  return (
    <span className="row-note" title="Matched with another order and settling on-chain; it can't be cancelled now">
      Matched
    </span>
  );
}

export default function OpenOrders({ open, history, error, onCancel }) {
  const { connected } = useWallet();
  const [tab, setTab] = useState("open");
  const rows = tab === "open" ? open : history;

  return (
    <section className="card orders">
      <div className="tabs">
        <button
          className={tab === "open" ? "on" : ""}
          onClick={() => setTab("open")}
        >
          Open orders ({open.length})
        </button>
        <button
          className={tab === "history" ? "on" : ""}
          onClick={() => setTab("history")}
        >
          Order history
        </button>
      </div>
      <div className="table-scroll">
        <div className="table-inner">
          <div className="thead head">
            {ORDER_COLUMNS.map((h) => (
              <span key={h}>{h}</span>
            ))}
          </div>
          {rows.map((o) => (
            <Row
              key={o.id}
              order={o}
              onCancel={tab === "open" ? onCancel : null}
            />
          ))}
        </div>
      </div>
      {!rows.length && (
        <div className="empty">
          <div className="empty-ico">{connected ? "▤" : "👛"}</div>
          <b>{tab === "open" ? "No open orders" : "No order history"}</b>
          <small>
            {connected
              ? "Place a limit order to start trading"
              : "Connect your wallet to start trading"}
          </small>
        </div>
      )}
    </section>
  );
}
