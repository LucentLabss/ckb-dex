import { useSyncExternalStore } from "react";
import { getPending, subscribePending } from "../services/pendingOrders.js";

/** Submitted-but-not-yet-indexed orders for a maker, shared across components. */
export function usePendingOrders(lockHash) {
  return useSyncExternalStore(subscribePending, () => getPending(lockHash));
}
