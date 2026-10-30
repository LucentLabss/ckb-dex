import { ccc } from "@ckb-ccc/connector-react";
import { ApiError } from "../services/api/http.js";

/** Thrown for problems the user can fix (bad input, missing setup), shown as-is. */
export class UserError extends Error {
  constructor(title, message, type = "warning") {
    super(message ?? title);
    this.name = "UserError";
    this.title = title;
    this.type = type;
  }
}

/** dex-order-lock exit codes (smart-contract/contracts/dex-order-lock/src/main.rs). */
const DEX_ERRORS = {
  [-2]: "the order data has the wrong length",
  [-4]: "the order price is invalid",
  [-9]: "the seller would be underpaid",
  [-10]: "the transaction spends the wrong number of order cells",
  [-14]: "the order version isn't supported",
  [-15]: "the order side is invalid",
  [-17]: "the token amount doesn't match the order",
  [-18]: "the buy and sell orders don't match on token, amount or price",
  [-19]: "the sell order doesn't hold the promised tokens",
  [-21]: "the buyer wouldn't receive the full token amount",
  [-24]: "the buy order doesn't hold enough CKB",
  [-25]: "a buy order can't carry a token",
  [-26]: "the buyer's leftover CKB wasn't returned",
  [-27]: "a cancellation must return the order's full CKB and tokens",
};

const REJECTED_RE = /reject|denied|declin|cancel+ed by user|user cancel|closed by user|popup closed|window closed/i;
const NETWORK_RE = /failed to fetch|networkerror|network request failed|load failed|ECONNREFUSED/i;
// A request cut off by its timeout ("The operation was aborted"), not a wallet refusal.
const TIMEOUT_RE = /\baborted\b|timed? ?out|timeout/i;

const shannonsToCkb = (n) => ccc.fixedPointToString(n);

/** Maps any thrown value to a short, non-technical { title, message, type }. */
export function describeError(action, error) {
  const failed = `${action} failed`;
  const raw = error?.message ?? String(error ?? "");

  if (error instanceof UserError) {
    return { title: error.title, message: error.title === error.message ? undefined : error.message, type: error.type };
  }

  if (error?.name === "AbortError" || error?.name === "TimeoutError" || TIMEOUT_RE.test(raw)) {
    return {
      title: "The network is slow",
      message:
        "The CKB node took too long to answer, so the request was stopped. If you were placing or cancelling an order, check Open orders before trying again.",
      type: "warning",
    };
  }

  if (REJECTED_RE.test(raw)) {
    return {
      title: `${action} cancelled`,
      message: "You declined the request in your wallet, so nothing was sent.",
      type: "warning",
    };
  }

  if (error instanceof ccc.ErrorTransactionInsufficientCapacity) {
    return {
      title: "Not enough CKB",
      message: `You need about ${shannonsToCkb(error.amount)} more CKB to cover this transaction and its network fee.`,
      type: "error",
    };
  }

  if (error instanceof ccc.ErrorTransactionInsufficientCoin) {
    return {
      title: "Not enough tokens",
      message: `Your wallet is short ${error.amount.toString()} token units for this order.`,
      type: "error",
    };
  }

  if (error instanceof ccc.ErrorClientVerification) {
    const reason = DEX_ERRORS[error.errorCode];
    return {
      title: failed,
      message: reason
        ? `The DEX contract rejected the transaction: ${reason}.`
        : `The network rejected the transaction (script error ${error.errorCode}).`,
      type: "error",
    };
  }

  if (error instanceof ccc.ErrorClientDuplicatedTransaction) {
    return { title: "Already submitted", message: "This transaction is already on the network.", type: "info" };
  }

  if (error instanceof ccc.ErrorClientResolveUnknown) {
    return {
      title: failed,
      message:
        "The network couldn't find one of the cells this transaction spends — it was already spent or belongs to a different network. Refresh the page and try again.",
      type: "error",
    };
  }

  if (error instanceof ccc.ErrorClientRBFRejected || error instanceof ccc.ErrorClientMaxFeeRateExceeded) {
    return {
      title: failed,
      message: "The network refused the transaction fee. Wait for your pending transaction to confirm, then retry.",
      type: "error",
    };
  }

  if (error instanceof ApiError) {
    return {
      title: failed,
      message:
        error.status >= 500
          ? "The LucentDex server had a problem. Please try again shortly."
          : `The server rejected the request: ${error.message}`,
      type: "error",
    };
  }

  if (NETWORK_RE.test(raw)) {
    return {
      title: "Connection problem",
      message: "Couldn't reach the LucentDex server or the CKB node. Check your connection and try again.",
      type: "error",
    };
  }

  return {
    title: failed,
    message: "Something unexpected went wrong. Details were logged to the browser console.",
    type: "error",
  };
}

/** Full technical detail for developers, grouped per action in the console. */
export function logError(action, error, context) {
  console.group(`%c[LucentDex] ${action} failed`, "color:#ff2d55;font-weight:bold");
  console.error(error);
  if (error?.cause) console.error("Caused by:", error.cause);
  if (error?.code !== undefined || error?.data !== undefined) {
    console.error("RPC code:", error.code, "data:", error.data);
  }
  if (context) console.error("Context:", context);
  console.groupEnd();
}

/** Console trail of successful user actions, to pair with logged failures. */
export function logAction(action, details) {
  console.info(`%c[LucentDex] ${action}`, "color:#12d98a;font-weight:bold", details ?? "");
}
