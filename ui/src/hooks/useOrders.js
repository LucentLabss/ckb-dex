import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWallet } from "../context/WalletContext.jsx";
import { useToast } from "../context/ToastContext.jsx";
import { marketApi, subscribe } from "../services/api/index.js";
import { buildCancelOrderTx, buildCreateOrderTx, readOwnOrderCell, walletDelta } from "../services/ckb/dex.js";
import { addPending, removePending } from "../services/pendingOrders.js";
import { usePendingOrders } from "./usePendingOrders.js";
import { useClosedOrdersVersion } from "./useClosedOrders.js";
import { closedStatus, markClosed } from "../services/closedOrders.js";
import { OPEN_STATUSES, pendingOrderRow, toOrderRow } from "../utils/orders.js";
import { logAction } from "../utils/errors.js";
import { fmtNum } from "../utils/format.js";

const PENDING_POLL_MS = 10_000;
/** Background builds kept for the confirmation sheet (most recent last). */
const MAX_PREBUILDS = 4;

/**
 * The connected maker's orders, from the backend REST API plus its realtime
 * `maker:<lockHash>:orders` channel, and the actions that create/cancel them
 * on-chain. Orders we just sent show as "Submitted" until the backend indexes
 * them; they're kept per wallet in the browser so a reload doesn't hide them.
 *
 * An order counts as filled or cancelled as soon as the closed-orders store
 * says so (see services/closedOrders.js), even if this wallet's own channel
 * hasn't caught up yet, so Open orders, the notice and the order book agree.
 */
export function useOrders() {
  const { signer, client, token, lock, lockHash, balance, tokenBalance, refreshBalances, trackTransaction } =
    useWallet();
  const { notify, notifyError } = useToast();
  const [docs, setDocs] = useState([]);
  const allPending = usePendingOrders(lockHash); // rows not yet indexed
  const pending = useMemo(
    () => allPending.filter((r) => !token || !r.xudtTypeHash || r.xudtTypeHash === token.typeHash),
    [allPending, token]
  );
  const [cancelling, setCancelling] = useState(() => new Set());
  const closedV = useClosedOrdersVersion();
  const [loadError, setLoadError] = useState(null);

  const load = useCallback(
    async (signal) => {
      if (!lockHash) return;
      try {
        const items = await marketApi.getOrders(
          { makerLockHash: lockHash, xudtTypeHash: token?.typeHash },
          { signal }
        );
        setDocs(items);
        setLoadError(null);
      } catch (err) {
        if (err.name === "AbortError") return;
        setLoadError("Couldn't load your orders — the server is unreachable.");
        notifyError("Loading your orders", err, { key: "orders-load", context: { lockHash } });
      }
    },
    [lockHash, token, notifyError]
  );

  useEffect(() => {
    setDocs([]);
    if (!lockHash) return;

    const ctrl = new AbortController();
    load(ctrl.signal);
    const unsubscribe = subscribe(`maker:${lockHash}:orders`, (items) => {
      if (Array.isArray(items)) {
        setDocs(token ? items.filter((d) => d.xudtTypeHash === token.typeHash) : items);
        setLoadError(null);
      }
    });
    return () => {
      ctrl.abort();
      unsubscribe();
    };
  }, [lockHash, token, load]);

  // Until the backend picks up our submitted orders, poll in case realtime is down.
  useEffect(() => {
    if (!pending.length) return;
    const id = setInterval(() => load(), PENDING_POLL_MS);
    return () => clearInterval(id);
  }, [pending.length, load]);

  // Drop pending rows once their tx shows up in the backend.
  useEffect(() => {
    if (!lockHash || !docs.length) return;
    removePending(lockHash, new Set(docs.map((d) => d.outPoint?.txHash ?? d.createdAtTxHash)));
  }, [docs, lockHash]);

  // Our own closed orders feed the shared store too (the order book reads it).
  useEffect(() => {
    markClosed(
      docs
        .filter((d) => d.status !== "LIVE" && !OPEN_STATUSES.has(d.status))
        .map((d) => [d.outPoint, d.status === "FILLED" ? "FILLED" : "CANCELED"])
    );
  }, [docs]);

  // Docs with the shared closed status applied: whichever signal arrives first wins.
  const effectiveDocs = useMemo(
    () =>
      docs.map((d) => {
        const closed = OPEN_STATUSES.has(d.status) && closedStatus(d.outPoint);
        return closed ? { ...d, status: closed } : d;
      }),
    // closedV: re-derive when the closed-orders store changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [docs, closedV]
  );

  // Tell the user when one of their open orders is filled or closes.
  const lastStatus = useRef(new Map());
  useEffect(() => {
    const prev = lastStatus.current;
    const next = new Map();
    let changed = false;
    for (const d of effectiveDocs) {
      const id = d._id ?? `${d.outPoint.txHash}:${d.outPoint.index}`;
      next.set(id, d.status);
      const before = prev.get(id);
      if (!before || before === d.status || !OPEN_STATUSES.has(before)) continue;
      const row = toOrderRow(d, token);
      const what = `${row.side} ${fmtNum(row.amount)} ${token?.symbol ?? ""} @ ${fmtNum(row.price)} CKB`;
      logAction(`Order ${d.status.toLowerCase()}`, d);
      changed = true;
      if (d.status === "FILLED") notify({ type: "success", title: "Order filled", message: what });
      else if (d.status === "CANCELED" || d.status === "CANCELLED") notify({ type: "info", title: "Order cancelled", message: what });
      else if (d.status === "INVALID" || d.status === "ORPHANED")
        notify({ type: "error", title: "Order closed", message: `${what} was marked ${row.status.toLowerCase()} by the indexer.` });
    }
    lastStatus.current = next;
    // A fill or cancel moves tokens/CKB into or out of the wallet.
    if (changed) refreshBalances();
  }, [effectiveDocs, token, notify, refreshBalances]);

  const { open, history } = useMemo(() => {
    const markCancelling = (row) =>
      cancelling.has(row.id) ? { ...row, status: "Cancelling", cancellable: false, cancelling: true } : row;
    const rows = effectiveDocs.map((d) => markCancelling(toOrderRow(d, token)));
    return {
      open: [...pending.map(markCancelling), ...rows.filter((r) => OPEN_STATUSES.has(r.rawStatus))],
      history: rows.filter((r) => !OPEN_STATUSES.has(r.rawStatus)),
    };
  }, [effectiveDocs, pending, cancelling, token]);

  /** Builds (but doesn't sign) the create-order tx, so its fee can be reviewed. */
  const buildOrder = useCallback(
    async (draft) => {
      if (!signer) throw new Error("Connect a wallet first.");
      const tx = await buildCreateOrderTx({
        signer,
        client,
        token,
        side: draft.contractSide,
        tokenAmount: draft.tokenAmount,
        totalPrice: draft.totalPrice,
      });
      const [fee, delta] = await Promise.all([tx.getFee(client), walletDelta(tx, client, lock, token)]);
      return { tx, fee, delta };
    },
    [signer, client, token, lock]
  );

  // Builds started in the background while the user fills in the form, so the
  // confirmation sheet usually opens with the exact fee already known. A build
  // is only reused for the same order and the same balances (its inputs must
  // still be unspent); sending anything clears them all.
  const prebuilds = useRef(new Map()); // key -> { promise, failed }
  const buildKey = useCallback(
    (draft) =>
      [lockHash, draft.contractSide, draft.tokenAmount, draft.totalPrice, balance, tokenBalance].join("|"),
    [lockHash, balance, tokenBalance]
  );
  useEffect(() => prebuilds.current.clear(), [lockHash, balance, tokenBalance]);

  const startBuild = useCallback(
    (draft) => {
      const key = buildKey(draft);
      const entry = { failed: false };
      entry.promise = buildOrder(draft);
      entry.promise.catch(() => {
        entry.failed = true;
      });
      prebuilds.current.delete(key);
      prebuilds.current.set(key, entry);
      while (prebuilds.current.size > MAX_PREBUILDS) {
        prebuilds.current.delete(prebuilds.current.keys().next().value);
      }
      return entry.promise;
    },
    [buildKey, buildOrder]
  );

  /** Starts building `draft` quietly in the background; errors surface only if it's reviewed. */
  const prebuildOrder = useCallback(
    (draft) => {
      if (!signer || prebuilds.current.has(buildKey(draft))) return;
      startBuild(draft).catch((err) =>
        console.debug("[LucentDex] Background order build failed (will retry on review):", err.message)
      );
    },
    [signer, buildKey, startBuild]
  );

  /** The built tx for `draft`: reuses a background build, or builds it now. */
  const prepareOrder = useCallback(
    (draft) => {
      const entry = prebuilds.current.get(buildKey(draft));
      if (!entry || entry.failed) return startBuild(draft);
      // A background build that fails (e.g. a slow RPC timed out) is retried once.
      return entry.promise.catch(() => startBuild(draft));
    },
    [buildKey, startBuild]
  );

  /**
   * Signs and sends a prepared create-order tx (from prepareOrder). `onStage`
   * hears "signing" (waiting for the wallet) then "sending". Resolves to the tx hash.
   */
  const placeOrder = useCallback(
    async (draft, { tx, delta }, onStage) => {
      onStage?.("signing");
      const signed = await signer.signTransaction(tx);
      onStage?.("sending");
      const txHash = await signer.client.sendTransaction(signed);
      prebuilds.current.clear(); // their inputs may be spent now
      const row = pendingOrderRow(draft, txHash, token);
      addPending(lockHash, row);
      trackTransaction(txHash, delta);
      logAction("Order submitted", { txHash, side: draft.side, tokenAmount: draft.tokenAmount, totalPrice: draft.totalPrice });
      notify({
        type: "success",
        title: "Order submitted",
        message: `${row.side} ${fmtNum(row.amount)} ${token.symbol} @ ${fmtNum(row.price)} CKB. It appears in Open orders once confirmed on-chain.`,
      });
      return txHash;
    },
    [signer, token, lockHash, trackTransaction, notify]
  );

  /**
   * Cancels an open order. A just-placed order the backend hasn't listed yet
   * is read from the chain instead (it's output 0 of the tx we sent).
   */
  const cancelOrder = useCallback(
    async (row) => {
      if (!signer || (!row.doc && !row.txHash)) return;
      setCancelling((s) => new Set(s).add(row.id));
      try {
        const order = row.doc ?? (await readOwnOrderCell({ client, makerLock: lock, txHash: row.txHash }));
        const tx = await buildCancelOrderTx({ signer, client, order });
        const delta = await walletDelta(tx, client, lock, token);
        const txHash = await signer.sendTransaction(tx);
        prebuilds.current.clear(); // their inputs may be spent now
        trackTransaction(txHash, delta);
        if (!row.doc) {
          // Never listed by the backend: drop it from our pending rows and everywhere else.
          removePending(lockHash, new Set([row.txHash]));
          markClosed([[order.outPoint, "CANCELED"]]);
        }
        logAction("Cancel submitted", { txHash, order: order.outPoint });
        notify({
          type: "info",
          title: "Cancellation submitted",
          message: "Your funds return to your wallet once the transaction confirms.",
        });
      } catch (err) {
        setCancelling((s) => {
          const next = new Set(s);
          next.delete(row.id);
          return next;
        });
        notifyError("Cancelling your order", err, { context: { order: row.doc ?? row.txHash } });
      }
    },
    [signer, client, lock, lockHash, token, trackTransaction, notify, notifyError]
  );

  return { open, history, loadError, prebuildOrder, prepareOrder, placeOrder, cancelOrder };
}
