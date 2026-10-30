import { useCallback, useEffect, useState } from "react";
import { useWallet } from "../context/WalletContext.jsx";
import { useToast } from "../context/ToastContext.jsx";
import { claimTokens, faucetEnabled, formatCooldown } from "../services/api/faucet.js";
import { logAction, logError } from "../utils/errors.js";
import { fmtUnits } from "../utils/format.js";

const KEY = (address) => `lucentdex:faucet-until:${address}`;

function readUntil(address) {
  try {
    return Number(localStorage.getItem(KEY(address))) || 0;
  } catch {
    return 0;
  }
}

function writeUntil(address, until) {
  try {
    localStorage.setItem(KEY(address), String(until));
  } catch {
    // Storage unavailable: the cooldown is still enforced by the faucet itself.
  }
}

/** Faucet-specific wording; anything else falls through to the generic error mapping. */
const STATUS_MESSAGES = {
  400: ["Can't send to this address", "The faucet only sends to CKB testnet addresses."],
  409: ["Claim already in progress", "Your previous claim is still being sent. Wait a moment."],
  503: ["Faucet is out for today", "Today's faucet budget is used up. Try again after 00:00 UTC."],
};

/**
 * "Get TOKEN" button state. A claim mints the market token to the connected
 * address; the new tokens show at once and are confirmed like our own txs.
 */
export function useFaucet() {
  const { address, token, trackTransaction } = useWallet();
  const { notify, notifyError } = useToast();
  const [loading, setLoading] = useState(false);
  const [until, setUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => setUntil(address ? readUntil(address) : 0), [address]);

  const coolingDown = until > now;
  useEffect(() => {
    if (!coolingDown) return;
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, [coolingDown]);

  const startCooldown = useCallback(
    (seconds) => {
      const next = Date.now() + seconds * 1000;
      writeUntil(address, next);
      setUntil(next);
      setNow(Date.now());
    },
    [address]
  );

  const claim = useCallback(async () => {
    if (!address || !token || loading) return;
    setLoading(true);
    try {
      const { txHash, amount } = await claimTokens(address);
      const units = BigInt(amount);
      trackTransaction(txHash, { ckb: 0n, token: units });
      startCooldown(24 * 60 * 60);
      logAction("Faucet claim sent", { txHash, amount, address });
      notify({
        type: "success",
        title: `${fmtUnits(units, token.decimals)} ${token.symbol} on the way`,
        message: "They show in your balance now and confirm in about a minute.",
      });
    } catch (err) {
      if (err.cooldownSeconds) {
        startCooldown(err.cooldownSeconds);
        logError("Claiming from the faucet", err, { address });
        notify({
          type: "warning",
          title: "Faucet cooldown",
          message: `You can claim again in ${formatCooldown(err.cooldownSeconds)}.`,
          key: "faucet",
        });
      } else if (STATUS_MESSAGES[err.status]) {
        logError("Claiming from the faucet", err, { address });
        const [title, message] = STATUS_MESSAGES[err.status];
        notify({ type: "warning", title, message, key: "faucet" });
      } else {
        notifyError("Claiming from the faucet", err, { key: "faucet", context: { address } });
      }
    } finally {
      setLoading(false);
    }
  }, [address, token, loading, trackTransaction, startCooldown, notify, notifyError]);

  return {
    enabled: faucetEnabled,
    loading,
    cooldownLabel: coolingDown ? formatCooldown(Math.ceil((until - now) / 1000)) : null,
    claim,
  };
}
