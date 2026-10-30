import { FAUCET_URL } from "../../config/env.js";
import { ApiError } from "./http.js";

/**
 * Client for the xUDT faucet service (ckb-dex/faucet, API under /api/v1/faucet).
 * A claim mints the demo token straight to `address`; the faucet pays the
 * token cell's CKB. Limits: per-address cooldown, per-IP throttle, daily budget.
 */
export class FaucetError extends ApiError {
  constructor(message, status, cooldownSeconds) {
    super(message, status);
    this.name = "FaucetError";
    this.cooldownSeconds = cooldownSeconds;
  }
}

/** Seconds left from the faucet's cooldown message ("... try again in 3600s"). */
function readCooldownSeconds(message) {
  const match = /try again in (\d+)s/i.exec(message ?? "");
  const seconds = match ? Number.parseInt(match[1], 10) : NaN;
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

export const faucetEnabled = Boolean(FAUCET_URL);

/** Resolves to { txHash, amount } (amount in token base units, as a string). */
export async function claimTokens(address) {
  const res = await fetch(`${FAUCET_URL}/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ address }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const message = body?.message ?? res.statusText;
    throw new FaucetError(message, res.status, res.status === 429 ? readCooldownSeconds(message) : null);
  }
  return body.data;
}

export function formatCooldown(seconds) {
  const totalMinutes = Math.max(1, Math.ceil(seconds / 60));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}
