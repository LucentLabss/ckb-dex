import { useSyncExternalStore } from "react";
import { closedVersion, subscribeClosed } from "../services/closedOrders.js";

/** Re-renders when an order is recorded as closed; returns the store's version. */
export function useClosedOrdersVersion() {
  return useSyncExternalStore(subscribeClosed, closedVersion);
}
