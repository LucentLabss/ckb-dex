import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { ccc } from "@ckb-ccc/connector-react";
import { useToast } from "./ToastContext.jsx";
import { logAction } from "../utils/errors.js";
import { NETWORK_LABEL, ckbClient } from "../services/ckb/client.js";
import { getMarketToken, getTokenBalance } from "../services/ckb/token.js";

const WalletContext = createContext(null);

const PRIMARY_WALLET = "JoyID Passkey";
const BALANCE_REFRESH_MS = 20_000;
const RECOMMENDED_SUFFIX = " · Recommended";

/** CCC's default wallet list with JoyID pinned first and labelled as recommended. */
class LucentSignersController extends ccc.SignersController {
  refresh(client, onUpdate, configs) {
    return super.refresh(
      client,
      (wallets) =>
        onUpdate(
          wallets
            .map((w) => (w.name === PRIMARY_WALLET ? { ...w, name: w.name + RECOMMENDED_SUFFIX } : w))
            .sort((a, b) => isPrimary(b) - isPrimary(a))
        ),
      configs
    );
  }
}

const isPrimary = (wallet) => wallet.name.startsWith(PRIMARY_WALLET);

/**
 * Wallet connection via CCC (https://github.com/ckb-devrel/ccc).
 * Supports JoyID, UTXO Global, Rei, UniSat, OKX, Xverse, Nostr and any
 * EIP-6963 EVM wallet (MetaMask etc.) through Omnilock. The last
 * connection is restored automatically on reload.
 */
export function WalletProvider({ children }) {
  const signersController = useMemo(() => new LucentSignersController(), []);
  return (
    <ccc.Provider
      name="LucentDex"
      icon={`${window.location.origin}/favicon.png`}
      defaultClient={ckbClient}
      hideKhie
      signersController={signersController}
      connectorProps={{ style: CONNECTOR_THEME }}
    >
      <WalletState>{children}</WalletState>
    </ccc.Provider>
  );
}

function WalletState({ children }) {
  const { open, disconnect, wallet, client } = ccc.useCcc();
  const { notifyError } = useToast();
  const signer = ccc.useSigner();
  const [account, setAccount] = useState(null); // { address, lock }
  const [balance, setBalance] = useState(null);
  const [token, setToken] = useState(null);
  const [tokenBalance, setTokenBalance] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);
  // Our own sent-but-unconfirmed transactions and their balance effect, applied
  // optimistically: the indexer only reflects a tx once it's in a block (~2 blocks).
  const [pendingTxs, setPendingTxs] = useState(() => new Map()); // txHash -> { ckb, token }

  useEffect(() => {
    getMarketToken().then(setToken, (err) => notifyError("Loading the market token", err, { key: "token" }));
  }, [notifyError]);

  useEffect(() => {
    if (!signer) {
      setAccount(null);
      return;
    }
    let cancelled = false;
    signer
      .getRecommendedAddressObj()
      .then((addr) => {
        if (cancelled) return;
        setAccount({ address: addr.toString(), lock: addr.script });
        logAction("Wallet connected", { wallet: wallet?.name, address: addr.toString() });
      })
      .catch((err) => notifyError("Reading your wallet address", err, { key: "wallet-address" }));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- wallet is only logged
  }, [signer, notifyError]);

  /** Reads both balances from the indexer; resolves to [ckb, token] (either may be null on error). */
  const fetchBalances = useCallback(async () => {
    if (!signer) return [null, null];
    const ckb = signer.getBalance().catch((err) => {
      notifyError("Loading your CKB balance", err, { key: "balance" });
      return null;
    });
    const tokens = token
      ? getTokenBalance(signer, token).catch((err) => {
          notifyError(`Loading your ${token.symbol} balance`, err, { key: "balance" });
          return null;
        })
      : Promise.resolve(null);
    return Promise.all([ckb, tokens]);
  }, [signer, token, notifyError]);

  const pendingRef = useRef(pendingTxs);
  pendingRef.current = pendingTxs;

  useEffect(() => {
    if (!signer) {
      setBalance(null);
      setTokenBalance(null);
      setPendingTxs(new Map());
      return;
    }
    let cancelled = false;
    fetchBalances().then(([ckb, tokens]) => {
      // While our own txs are pending their optimistic delta is shown on top of the
      // last confirmed balance; a fresh read could already include one of them and
      // count it twice. trackTransaction re-reads once they confirm.
      if (cancelled || pendingRef.current.size) return;
      if (ckb !== null) setBalance(ckb);
      if (tokens !== null) setTokenBalance(tokens);
    });
    return () => {
      cancelled = true;
    };
  }, [signer, fetchBalances, refreshKey]);

  const refreshBalances = useCallback(() => setRefreshKey((k) => k + 1), []);

  /**
   * Shows `delta` ({ ckb, token }) on the balances straight away, then swaps it
   * for real balances once `txHash` is committed.
   */
  const trackTransaction = useCallback(
    (txHash, delta) => {
      setPendingTxs((m) => new Map(m).set(txHash, delta));
      const settle = async () => {
        try {
          await client.waitTransaction(txHash, 0, 120_000, 2_000);
        } catch (err) {
          console.warn(`[LucentDex] Still waiting for ${txHash} to confirm:`, err.message);
        }
        const [ckb, tokens] = await fetchBalances();
        // One render: real balances in, the optimistic delta out.
        if (ckb !== null) setBalance(ckb);
        if (tokens !== null) setTokenBalance(tokens);
        setPendingTxs((m) => {
          const next = new Map(m);
          next.delete(txHash);
          return next;
        });
        logAction("Balances updated after confirmation", { txHash });
      };
      settle();
    },
    [client, fetchBalances]
  );

  // Fills and payouts arrive in transactions the bot sends, so re-read balances
  // periodically (skipped while our own txs are pending, to avoid double counting).
  useEffect(() => {
    if (!signer || pendingTxs.size) return;
    const id = setInterval(refreshBalances, BALANCE_REFRESH_MS);
    return () => clearInterval(id);
  }, [signer, pendingTxs.size, refreshBalances]);

  const shownBalances = useMemo(() => {
    let ckb = balance;
    let tokens = tokenBalance;
    for (const d of pendingTxs.values()) {
      if (ckb !== null) ckb += d.ckb;
      if (tokens !== null) tokens += d.token;
    }
    return { ckb, tokens };
  }, [balance, tokenBalance, pendingTxs]);

  const value = useMemo(
    () => ({
      address: account?.address ?? null,
      lock: account?.lock ?? null,
      lockHash: account?.lock.hash() ?? null,
      connected: Boolean(account),
      walletName: wallet?.name.replace(RECOMMENDED_SUFFIX, "") ?? null,
      walletIcon: wallet?.icon ?? null,
      network: NETWORK_LABEL,
      client,
      signer,
      token,
      /** Plain CKB in shannons (bigint), including our unconfirmed txs */
      balance: shownBalances.ckb,
      /** Token base units (bigint), including our unconfirmed txs */
      tokenBalance: shownBalances.tokens,
      /** True while a tx we sent is unconfirmed and its effect is shown optimistically */
      balancePending: pendingTxs.size > 0,
      refreshBalances,
      trackTransaction,
      connect: open,
      disconnect,
    }),
    [account, wallet, client, signer, token, shownBalances, pendingTxs, refreshBalances, trackTransaction, open, disconnect]
  );
  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

/** Match the CCC modal to the dark LucentDex palette. */
const CONNECTOR_THEME = {
  "--background": "#07122b",
  "--divider": "#13264d",
  "--btn-primary": "#0a1a3a",
  "--btn-primary-hover": "#13264d",
  "--btn-secondary": "#13264d",
  "--btn-secondary-hover": "#1c3566",
  "--icon-primary": "#f2f6ff",
  "--icon-secondary": "#8ea3c9",
  "--tip-color": "#8ea3c9",
  color: "#f2f6ff",
  fontFamily: "var(--font)",
};

export function useWallet() {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error("useWallet must be used inside <WalletProvider>");
  return ctx;
}
