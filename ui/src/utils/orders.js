import { ccc } from "@ckb-ccc/connector-react";
import { SIDE_BUY, SIDE_SELL } from "../services/ckb/dex.js";

const CKB_DECIMALS = 8;
const MAX_U64 = 0xffff_ffff_ffff_ffffn;
const DECIMAL_RE = /^\d*\.?\d+$|^\d+\.$/;

function parseUnits(text, decimals) {
  const s = String(text ?? "").trim();
  if (!DECIMAL_RE.test(s)) return null;
  const [, frac = ""] = s.split(".");
  if (frac.length > decimals) return null;
  return ccc.fixedPointFrom(s, decimals);
}

/**
 * Turns form input into an on-chain order draft, or `{ error }`.
 * "buy" buys the token with CKB (BID); "sell" sells held token for CKB (ASK).
 * Order price is CKB per whole token; the contract stores the order total.
 */
export function buildOrderDraft({ side, orderPrice, amount }, token) {
  const fail = (field, error) => ({ field, error });
  if (!token) return fail(null, "Trading is unavailable because no market token is configured.");

  if (!String(orderPrice ?? "").trim()) return fail("orderPrice", "Enter the price in CKB you want per token.");
  const pricePerToken = parseUnits(orderPrice, CKB_DECIMALS);
  if (pricePerToken === null) {
    return fail("orderPrice", "Order price must be a number with at most 8 decimal places (e.g. 12.5).");
  }
  if (pricePerToken <= 0n) return fail("orderPrice", "Order price must be greater than 0 CKB.");

  if (!String(amount ?? "").trim()) return fail("amount", `Enter how many ${token.symbol} you want to ${side === "buy" ? "buy" : "sell"}.`);
  const tokenAmount = parseUnits(amount, token.decimals);
  if (tokenAmount === null) {
    return fail(
      "amount",
      token.decimals
        ? `Amount must be a number with at most ${token.decimals} decimal places.`
        : `${token.symbol} can't be split — enter a whole number.`
    );
  }
  if (tokenAmount <= 0n) return fail("amount", `Amount must be greater than 0 ${token.symbol}.`);

  const totalPrice = (pricePerToken * tokenAmount) / 10n ** BigInt(token.decimals);
  if (totalPrice <= 0n) return fail("orderPrice", "The order total rounds down to 0 CKB — raise the price or amount.");
  if (totalPrice > MAX_U64) return fail("amount", "The order total is larger than the contract allows. Reduce the price or amount.");

  return {
    side,
    type: "limit",
    contractSide: side === "buy" ? SIDE_BUY : SIDE_SELL,
    pricePerToken,
    tokenAmount,
    totalPrice,
  };
}

/** Checks a draft against the wallet's balances. Returns { field, title, message } or null. */
export function checkFunds(draft, { balance, tokenBalance, token, requiredCkb }) {
  if (draft.side === "sell") {
    if (tokenBalance !== null && draft.tokenAmount > tokenBalance) {
      return {
        field: "amount",
        title: `Not enough ${token.symbol}`,
        message: `You're selling ${ccc.fixedPointToString(draft.tokenAmount, token.decimals)} ${token.symbol} but your wallet holds ${ccc.fixedPointToString(tokenBalance, token.decimals)}.`,
      };
    }
  } else if (balance !== null && requiredCkb > balance) {
    return {
      field: "amount",
      title: "Not enough CKB",
      message: `This buy order locks ${ccc.fixedPointToString(requiredCkb)} CKB (price + token cell + settlement fee reserve) but your wallet holds ${ccc.fixedPointToString(balance)} CKB.`,
    };
  }
  return null;
}

const STATUS_LABELS = {
  DISCOVERED: "Confirming",
  LIVE: "Open",
  RESERVED: "Settling",
  PENDING: "Settling",
  SETTLEMENT_SUBMITTED: "Settling",
  FILLED: "Filled",
  CANCELED: "Cancelled",
  CANCELLED: "Cancelled",
  INVALID: "Invalid",
  ORPHANED: "Orphaned",
};

/** Statuses that belong in the "Open orders" tab. */
export const OPEN_STATUSES = new Set(["DISCOVERED", "LIVE", "RESERVED", "PENDING", "SETTLEMENT_SUBMITTED"]);

/** Maps a backend OrderDocument (ckb-dex/backend/src/models/order.ts) to a table row. */
export function toOrderRow(doc, token) {
  const decimals = token?.decimals ?? 0;
  const isV2 = doc.orderVersion === 2 || doc.priceNum !== undefined || doc.marketConfigHash !== undefined;

  let amount = 0;
  let price = 0;
  let total = 0;

  if (isV2) {
    const isClosed = !OPEN_STATUSES.has(doc.status);
    const amountUnits = BigInt(
      (isClosed ? (doc.initialBase ?? doc.tokenAmount) : null) ??
      doc.remainingBase ??
      doc.remainingAmount ??
      doc.tokenAmount ??
      doc.initialBase ??
      0
    );
    amount = Number(ccc.fixedPointToString(amountUnits, decimals));

    const priceNum = BigInt(doc.priceNum ?? doc.pricePerToken ?? 0);
    const priceDen = BigInt(doc.priceDen ?? 1) || 1n;
    const unitPrice = Number(priceNum) / Number(priceDen);
    price = (unitPrice * Math.pow(10, decimals)) / 1e8;
    total = price * amount;
  } else {
    const amountUnits = BigInt(doc.remainingAmount ?? doc.tokenAmount ?? 0);
    const totalShannons = BigInt(doc.pricePerToken ?? 0);
    amount = Number(ccc.fixedPointToString(amountUnits, decimals));
    total = Number(ccc.fixedPointToString(totalShannons, CKB_DECIMALS));
    price = amount ? total / amount : 0;
  }

  return {
    id: doc._id ?? `${doc.outPoint.txHash}:${doc.outPoint.index}`,
    pair: `${token?.symbol ?? "xUDT"}/CKB`,
    side: doc.direction === "BID" ? "Buy" : "Sell",
    type: "Limit",
    price,
    amount,
    total,
    status: STATUS_LABELS[doc.status] ?? doc.status,
    rawStatus: doc.status,
    cancellable: doc.status === "LIVE",
    time: new Date(doc.createdAt ?? Date.now()),
    doc,
  };
}

/** Row for an order we just submitted that the backend hasn't indexed yet. */
export function pendingOrderRow(draft, txHash, token) {
  const amount = Number(ccc.fixedPointToString(draft.tokenAmount, token.decimals));
  const total = Number(ccc.fixedPointToString(draft.totalPrice, CKB_DECIMALS));
  return {
    id: `${txHash}:0`,
    txHash,
    xudtTypeHash: token.typeHash,
    pair: `${token.symbol}/CKB`,
    side: draft.side === "buy" ? "Buy" : "Sell",
    type: draft.type === "market" ? "Market" : "Limit",
    price: total / amount,
    amount,
    total,
    status: "Submitted",
    rawStatus: "SUBMITTED",
    pending: true,
    // Cancellable as soon as the order tx is on-chain (read from the chain directly).
    cancellable: true,
    time: new Date(),
  };
}

/** Default slippage tolerance for market orders (fraction of the worst book price crossed). */
export const MARKET_SLIPPAGE = 0.01;

/** Formats a CKB price with at most 8 decimals, never in exponent notation. */
const toPriceInput = (n) => n.toFixed(CKB_DECIMALS).replace(/\.?0+$/, "");

/**
 * Prices a market order from the live book. The DEX has no instant execution,
 * so a market order is a limit order priced to cross the book: it walks the
 * opposite side (best price first) until `amount` is covered, then pads the
 * worst price crossed by `slippage` so it stays marketable if the book moves.
 * Returns { avgPrice, worstPrice, limitPrice (string, CKB per token) } or { field, error }.
 */
export function quoteMarketOrder({ side, amount, asks, bids, token, slippage = MARKET_SLIPPAGE }) {
  const fail = (error) => ({ field: "amount", error });
  const wanted = Number(String(amount ?? "").trim());
  if (!String(amount ?? "").trim() || !Number.isFinite(wanted) || wanted <= 0) {
    return fail(`Enter how many ${token?.symbol ?? "tokens"} you want to ${side === "buy" ? "buy" : "sell"}.`);
  }
  const levels = (side === "buy" ? asks : bids).filter((r) => !r.pending && !r.settling && r.amount > 0);
  if (!levels.length) {
    return fail(`There are no ${side === "buy" ? "sell" : "buy"} orders to fill against. Place a limit order instead.`);
  }

  let filled = 0;
  let cost = 0;
  let worstPrice = levels[0].price;
  for (const level of levels) {
    const take = Math.min(level.amount, wanted - filled);
    filled += take;
    cost += take * level.price;
    worstPrice = level.price;
    if (filled >= wanted) break;
  }
  if (filled < wanted) {
    return fail(
      `Only ${filled.toLocaleString("en-US", { maximumFractionDigits: token?.decimals ?? 8 })} ${token?.symbol ?? ""} is available on the other side of the book. Reduce the amount or place a limit order.`
    );
  }

  const padded = side === "buy" ? worstPrice * (1 + slippage) : worstPrice * (1 - slippage);
  return { avgPrice: cost / filled, worstPrice, limitPrice: toPriceInput(padded), slippage };
}
