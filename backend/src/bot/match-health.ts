// Tracks failed settlement attempts so one bad order or pair cannot stall the rest of the book.

const BASE_PAIR_BACKOFF_MS = 5_000;
const MAX_PAIR_BACKOFF_MS = 10 * 60_000;

export const ORDER_QUARANTINE_MS = 60 * 60_000;

interface PairState {
  failures: number;
  until: number;
}

export class MatchHealth {
  private readonly quarantinedOrders = new Map<string, number>();
  private readonly pairs = new Map<string, PairState>();

  static pairKey(buyId: string, sellId: string): string {
    return `${buyId}|${sellId}`;
  }

  /** Skip an order that can never settle (e.g. too little capacity) until `ms` have passed. */
  quarantineOrder(orderId: string, ms: number = ORDER_QUARANTINE_MS, now: number = Date.now()): void {
    this.quarantinedOrders.set(orderId, now + ms);
  }

  isOrderQuarantined(orderId: string, now: number = Date.now()): boolean {
    const until = this.quarantinedOrders.get(orderId);
    if (until === undefined) return false;
    if (until <= now) {
      this.quarantinedOrders.delete(orderId);
      return false;
    }
    return true;
  }

  /** Exponential backoff for a pair whose attempt failed for a possibly transient reason. */
  recordPairFailure(buyId: string, sellId: string, now: number = Date.now()): number {
    const key = MatchHealth.pairKey(buyId, sellId);
    const failures = (this.pairs.get(key)?.failures ?? 0) + 1;
    const delay = Math.min(BASE_PAIR_BACKOFF_MS * 2 ** (failures - 1), MAX_PAIR_BACKOFF_MS);
    this.pairs.set(key, { failures, until: now + delay });
    return delay;
  }

  isPairBlocked(buyId: string, sellId: string, now: number = Date.now()): boolean {
    const state = this.pairs.get(MatchHealth.pairKey(buyId, sellId));
    return state !== undefined && state.until > now;
  }

  recordSuccess(buyId: string, sellId: string): void {
    this.pairs.delete(MatchHealth.pairKey(buyId, sellId));
  }

  /** Forget state for orders that are no longer in play so the maps cannot grow without bound. */
  prune(liveOrderIds: ReadonlySet<string>, now: number = Date.now()): void {
    for (const [id, until] of this.quarantinedOrders) {
      if (until <= now || !liveOrderIds.has(id)) this.quarantinedOrders.delete(id);
    }
    for (const [key, state] of this.pairs) {
      const [buyId, sellId] = key.split("|");
      if (state.until <= now && (!liveOrderIds.has(buyId) || !liveOrderIds.has(sellId))) this.pairs.delete(key);
    }
  }
}
