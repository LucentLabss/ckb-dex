import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useWallet } from "../../context/WalletContext.jsx";
import { useToast } from "../../context/ToastContext.jsx";
import { ESTIMATED_ORDER_FEE, SETTLEMENT_FEE_RESERVE, sellOrderDeposit } from "../../services/ckb/dex.js";
import { fmtCkb, fmtUnits, shortAddr } from "../../utils/format.js";

/**
 * Order review sheet. Slides up from the bottom-right over a blurred backdrop
 * and stays open until the user closes it or fulfils the order; clicking the
 * backdrop does nothing. The tx is built (not signed) on open so the real
 * network fee is shown, and "Fulfil order" signs exactly that tx. It is
 * usually built already in the background; until it is, the sheet shows
 * estimates (marked ≈) and a status line, as it does while the wallet is
 * asking for approval and while the tx is being sent.
 */
export default function OrderConfirmModal({ draft, onPrepare, onConfirm, onClose }) {
  const { token, address, lock, walletName, network } = useWallet();
  const { notifyError } = useToast();
  const [prepared, setPrepared] = useState(null); // { tx, fee }
  // preparing | ready | signing (waiting for the wallet) | sending
  const [stage, setStage] = useState("preparing");
  const [error, setError] = useState(null);
  const busy = stage === "signing" || stage === "sending";

  useEffect(() => {
    let cancelled = false;
    onPrepare(draft)
      .then((p) => {
        if (cancelled) return;
        setPrepared(p);
        setStage("ready");
      })
      .catch((err) => {
        if (cancelled) return;
        setError(true);
        setStage("ready");
        notifyError("Preparing your order", err, { context: { draft } });
      });
    return () => {
      cancelled = true;
    };
  }, [draft, onPrepare, notifyError]);

  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && !busy && onClose();
    window.addEventListener("keydown", onKey);
    document.body.classList.add("modal-open");
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.classList.remove("modal-open");
    };
  }, [busy, onClose]);

  const fulfil = async () => {
    setStage("signing");
    try {
      await onConfirm(draft, prepared, setStage);
    } catch (err) {
      setStage("ready");
      notifyError("Placing your order", err, { context: { draft, tx: prepared.tx } });
    }
  };

  const isLong = draft.side === "long";
  const tokenAmt = `${fmtUnits(draft.tokenAmount, token.decimals, token.decimals)} ${token.symbol}`;
  const exact = Boolean(prepared);
  const estimating = !exact && stage === "preparing";
  // CKB that leaves the plain balance, from the actual prepared tx (fee included).
  const ckbOut = exact ? -prepared.delta.ckb : null;
  // A sell order's cell holds a CKB deposit that's paid back, with the price, when it fills.
  // It depends only on the order, so it's known before the tx is built.
  const deposit = isLong
    ? null
    : exact
      ? prepared.tx.outputs[0].capacity
      : sellOrderDeposit(lock, token, draft.tokenAmount, draft.totalPrice);
  const tokenCell = isLong ? draft.lockedCkb - draft.totalPrice - SETTLEMENT_FEE_RESERVE : null;
  const pendingText = estimating ? <Calculating /> : "—";
  const approx = (value) => (estimating ? `≈ ${value}` : value);

  const rows = [
    ["Pair", `${token.symbol} / CKB`],
    ["Order type", "Limit"],
    ["Price", `${fmtUnits(draft.pricePerToken, 8, 8)} CKB / ${token.symbol}`],
    ["Amount", tokenAmt],
    ["Order total", fmtCkb(draft.totalPrice, 8)],
    isLong
      ? [
          "Leaves your wallet",
          ckbOut !== null ? fmtCkb(ckbOut, 8) : approx(fmtCkb(draft.lockedCkb + ESTIMATED_ORDER_FEE, 8)),
          `Order total + ${fmtCkb(tokenCell, 0)} to hold the ${token.symbol} you receive + fees`,
        ]
      : [
          "Leaves your wallet",
          ckbOut !== null ? (
            `${tokenAmt} + ${fmtCkb(ckbOut, 8)}`
          ) : (
            <>
              {tokenAmt} + {pendingText}
            </>
          ),
          `The CKB is the order cell's deposit (${deposit !== null ? fmtCkb(deposit, 0) : "…"}) plus fees`,
        ],
    isLong
      ? ["You receive when filled", tokenAmt, `In a token cell holding ${fmtCkb(tokenCell, 0)}, counted with the token, not your CKB balance`]
      : [
          "You receive when filled",
          deposit !== null ? fmtCkb(draft.totalPrice + deposit, 8) : fmtCkb(draft.totalPrice, 8),
          "Order total plus your deposit back",
        ],
    ["Network fee", exact ? fmtCkb(prepared.fee, 8) : estimating ? approx(fmtCkb(ESTIMATED_ORDER_FEE, 8)) : "—"],
    ["Wallet", shortAddr(address, 10, 6), walletName],
    ["Network", network],
  ];

  return createPortal(
    <div className="sheet-backdrop" role="presentation">
      <section
        className={`sheet ${isLong ? "long" : "short"}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
      >
        <header className="sheet-h">
          <div>
            <h2 id="confirm-title">Confirm order</h2>
            <span className={`side-badge ${isLong ? "up" : "down"}`}>
              {isLong ? "Long · Buy" : "Short · Sell"} {token.symbol}
            </span>
          </div>
          <button className="sheet-x" onClick={onClose} disabled={busy} aria-label="Close">
            ✕
          </button>
        </header>

        <dl className="sheet-rows">
          {rows.map(([k, v, hint]) => (
            <div key={k} className={k === "Leaves your wallet" ? "hl" : ""}>
              <dt>
                {k}
                {hint && <small>{hint}</small>}
              </dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>

        <p className="sheet-note">
          ⓘ Orders settle all-or-nothing: this order fills only against a counter-order for exactly{" "}
          {tokenAmt} at {fmtCkb(draft.totalPrice, 8)} in total. Check every value above before signing —
          your wallet will ask you to approve the transaction.
        </p>

        {error && (
          <p className="form-error" role="alert">
            This order can't be placed as entered. Close this window, adjust it and try again.
          </p>
        )}

        {(estimating || busy) && (
          <p className="sheet-status" role="status" aria-live="polite">
            <span className="spinner" aria-hidden="true" />
            {stage === "signing"
              ? `Waiting for ${walletName ?? "your wallet"} — approve the transaction there to continue.`
              : stage === "sending"
                ? "Sending your order to the CKB network…"
                : "Calculating the exact fee and what leaves your wallet…"}
          </p>
        )}

        <div className="sheet-actions">
          <button className="cta ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className={`cta go ${isLong ? "" : "sell"}`}
            onClick={fulfil}
            disabled={!prepared || busy}
          >
            {estimating || busy ? <span className="spinner" aria-hidden="true" /> : null}
            {estimating
              ? "Preparing…"
              : stage === "signing"
                ? "Approve in wallet…"
                : stage === "sending"
                  ? "Sending…"
                  : "Fulfil order"}
          </button>
        </div>
      </section>
    </div>,
    document.body
  );
}

function Calculating() {
  return (
    <span className="calc">
      <span className="spinner" aria-hidden="true" />
      Calculating…
    </span>
  );
}
