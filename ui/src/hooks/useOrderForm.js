import { useEffect, useRef, useState } from "react";
import { useWallet } from "../context/WalletContext.jsx";
import { useMarket } from "../context/MarketContext.jsx";
import { useToast } from "../context/ToastContext.jsx";
import { buyOrderCapacity } from "../services/ckb/dex.js";
import { buildOrderDraft, checkFunds, quoteMarketOrder } from "../utils/orders.js";
import { logAction } from "../utils/errors.js";
import { toInputNumber } from "../utils/format.js";

/**
 * Order form state. `type` is "market" (the default) or "limit". A market
 * order has no price field: its price is quoted from the live book (see
 * quoteMarketOrder) and re-quoted as the book changes. For a limit order the
 * price defaults to the current market price (last
 * traded) and keeps following it until the user edits the field. Submitting
 * validates the input and hands a draft (with the CKB it will lock) and a
 * reset callback to `onReview`; nothing is signed here.
 *
 * While the user types, a valid and affordable order is also handed to
 * `onDraftReady` (after a short pause) so its transaction can be built in
 * the background before they click Review.
 */
const DRAFT_READY_DELAY_MS = 600;

export function useOrderForm({ onReview, onDraftReady }) {
  const { token, lock, balance, tokenBalance } = useWallet();
  const { marketPrice, asks, bids } = useMarket();
  const { notify } = useToast();
  const [side, setSide] = useState("buy");
  const [type, setType] = useState("market");
  const [values, setValues] = useState({ orderPrice: "", amount: "" });
  const [invalid, setInvalid] = useState(null); // field name to highlight
  const priceTouched = useRef(false);

  useEffect(() => {
    if (!priceTouched.current && marketPrice !== null && marketPrice !== undefined) {
      setValues((v) => ({ ...v, orderPrice: toInputNumber(marketPrice) }));
    }
  }, [marketPrice]);

  const setField = (name) => (e) => {
    if (name === "orderPrice") priceTouched.current = e.target.value !== "";
    setValues((v) => ({ ...v, [name]: e.target.value }));
    setInvalid(null);
  };

  /** Fill the price from elsewhere (e.g. clicking an order book row); switches to a limit order. */
  const setPrice = (price) => {
    priceTouched.current = true;
    setType("limit");
    setValues((v) => ({ ...v, orderPrice: toInputNumber(price) }));
    setInvalid(null);
  };

  /** Live quote for a market order, or null for a limit order. */
  const quote = type === "market" ? quoteMarketOrder({ side, amount: values.amount, asks, bids, token }) : null;

  /** The draft for the current inputs, or { field, error }. */
  const draftFromInputs = () => {
    if (type !== "market" || !token) return buildOrderDraft({ side, ...values }, token);
    if (quote.error) return quote;
    const draft = buildOrderDraft({ side, orderPrice: quote.limitPrice, amount: values.amount }, token);
    if (draft.error) return draft.field === "orderPrice" ? { field: "amount", error: draft.error } : draft;
    return { ...draft, type: "market", avgPrice: quote.avgPrice, slippage: quote.slippage };
  };

  /** The order as entered, or null if it isn't valid or affordable yet. Never notifies. */
  const currentDraft = () => {
    if (!token || !lock) return null;
    const draft = draftFromInputs();
    if (draft.error) return null;
    const lockedCkb =
      side === "buy" ? buyOrderCapacity(lock, token, draft.tokenAmount, draft.totalPrice) : null;
    if (checkFunds(draft, { balance, tokenBalance, token, requiredCkb: lockedCkb })) return null;
    return { ...draft, lockedCkb };
  };

  useEffect(() => {
    if (!onDraftReady) return;
    const id = setTimeout(() => {
      const draft = currentDraft();
      if (draft) onDraftReady(draft);
    }, DRAFT_READY_DELAY_MS);
    return () => clearTimeout(id);
    // currentDraft reads exactly these values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [side, type, values, asks, bids, token, lock, balance, tokenBalance, onDraftReady]);

  const reset = () => {
    priceTouched.current = false;
    setValues({ orderPrice: toInputNumber(marketPrice), amount: "" });
  };

  const reject = (field, title, message) => {
    setInvalid(field);
    notify({ type: "warning", title, message, key: "order-form" });
    console.warn(`[LucentDex] Order form: ${title}`, { side, type, ...values });
  };

  const submit = (e) => {
    e?.preventDefault();
    const draft = draftFromInputs();
    if (draft.error) return reject(draft.field, "Check your order", draft.error);

    const lockedCkb =
      side === "buy" ? buyOrderCapacity(lock, token, draft.tokenAmount, draft.totalPrice) : null;
    const problem = checkFunds(draft, { balance, tokenBalance, token, requiredCkb: lockedCkb });
    if (problem) return reject(problem.field, problem.title, problem.message);

    setInvalid(null);
    logAction("Order review opened", { side, type, ...values });
    onReview({ ...draft, lockedCkb }, reset);
  };

  const changeType = (next) => {
    setType(next);
    setInvalid(null);
  };

  return { side, setSide, type, setType: changeType, quote, values, setField, setPrice, invalid, submit, reset };
}
