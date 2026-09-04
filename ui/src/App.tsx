import { useEffect, useMemo, useRef, useState } from "react";
import { Provider, useCcc } from "@ckb-ccc/connector-react";
import { ccc } from "@ckb-ccc/core";
import { Check, Copy } from "lucide-react";
import {
  buildCancelOrderTx,
  buildCreateOrderTx,
  DEX_NETWORK,
  SIDE_BUY,
  SIDE_SELL,
  systemScripts,
  xudtType,
  xudtTypeHash,
  type CancelableOrder,
} from "./lib/dex";
import "./App.css";

type Side = "buy" | "sell";
type OrderType = "limit" | "market";
type TabMode = "open" | "history";
type OrderStatus = "Open" | "Pending" | "Filled" | "Cancelled";

type MarketRow = {
  price: number;
  amount: number;
  cumulative?: number;
};

type Order = {
  id: string;
  side: Side;
  type: OrderType;
  price: number;
  amount: number;
  total: number;
  time: Date;
  status: OrderStatus;
  raw?: CancelableOrder;
};

type ApiScript = { codeHash: string; hashType: string; args: string };

type ApiOrderItem = {
  _id?: string;
  outPoint?: { txHash: string; index: string };
  direction?: "ASK" | "BID";
  status?: string;
  pricePerToken?: string;
  remainingAmount?: string;
  tokenAmount?: string;
  capacity?: string;
  ownerLock?: ApiScript;
  typeScript?: ApiScript;
  cellData?: string;
  xudtTypeHash?: string;
  createdAt?: string;
};

type ApiTradeItem = {
  settlementTxHash?: string;
  price?: string;
  tokenAmount?: string;
  confirmedAtBlock?: string;
  createdAt?: string;
};

type TradeEntry = {
  time: string;
  price: string;
  amount: string;
  side: Side;
  hash: string;
};

const fixtureAsks: MarketRow[] = [
  { price: 0.008201, amount: 42000 },
  { price: 0.008195, amount: 18500 },
  { price: 0.008188, amount: 65200 },
  { price: 0.008179, amount: 12300 },
  { price: 0.008171, amount: 28900 },
  { price: 0.008163, amount: 51000 },
  { price: 0.008156, amount: 9400 },
  { price: 0.008148, amount: 33700 },
];

const fixtureBids: MarketRow[] = [
  { price: 0.008132, amount: 31200 },
  { price: 0.008125, amount: 47600 },
  { price: 0.008118, amount: 15300 },
  { price: 0.00811, amount: 62800 },
  { price: 0.008103, amount: 22100 },
  { price: 0.008095, amount: 8700 },
  { price: 0.008088, amount: 39500 },
  { price: 0.00808, amount: 17600 },
];

const fixtureTrades: TradeEntry[] = [
  { time: "12:42:18", price: "0.008140", amount: "150", side: "buy", hash: "0x91a3...44b2" },
  { time: "12:39:02", price: "0.008150", amount: "60", side: "sell", hash: "0x0cfa...8e31" },
  { time: "12:31:47", price: "0.008138", amount: "220", side: "buy", hash: "0x7d02...9c10" },
  { time: "12:26:11", price: "0.008160", amount: "80", side: "sell", hash: "0x321e...51aa" },
];

const defaultMidPrice = 0.00814;
const apiBase = import.meta.env.VITE_API_URL ?? "http://localhost:3000/api/v1";
const wsBase =
  (import.meta.env.VITE_WS_URL as string | undefined) ??
  apiBase.replace(/^http/, "ws").replace(/\/api\/v\d+\/?$/, "");
const tradingPairLabel = xudtTypeHash ? "TOKEN / CKB" : "DEMO / CKB";
const marketReady = Boolean(xudtTypeHash);

// In dev the app always talks to the vite proxy at /api/ckb-rpc (the local CKB node has
// no CORS headers of its own - see vite.config.ts). In a production build, fall back to a
// directly reachable RPC URL if one was configured at build time.
const ckbRpcUrl =
  import.meta.env.DEV || !import.meta.env.VITE_CKB_RPC_URL
    ? "/api/ckb-rpc"
    : (import.meta.env.VITE_CKB_RPC_URL as string);

const ckbClient = new ccc.ClientPublicTestnet({
  url: ckbRpcUrl,
  scripts: systemScripts,
  fallbacks: [],
});

// Dev-only escape hatch: JoyID (and most hosted/extension wallets) can't represent a local
// devnet identity - they're tied to real testnet/mainnet. This lets local devnet testing use
// a plain private key (e.g. offchain/.env's MAKER_PRIVATE_KEY, which already holds devnet CKB
// and demo tokens) instead. Never exposed outside dev builds - a raw key in the browser is
// only acceptable for throwaway devnet funds.
const devPrivateKey = import.meta.env.DEV
  ? (import.meta.env.VITE_DEV_PRIVATE_KEY as string | undefined)
  : undefined;

function App() {
  return (
    <Provider defaultClient={ckbClient}>
      <WalletApp />
    </Provider>
  );
}

function WalletApp() {
  const [side, setSide] = useState<Side>("buy");
  const [orderType, setOrderType] = useState<OrderType>("limit");
  const [priceInput, setPriceInput] = useState(String(defaultMidPrice));
  const [amountInput, setAmountInput] = useState("");
  const [activeTab, setActiveTab] = useState<TabMode>("open");
  // Orders as last reported by the backend, and orders we know about locally (just
  // placed/cancelled) that the backend hasn't reflected yet - e.g. because the bot hasn't
  // indexed/matched them yet (see the DexOrderBot-not-running issue). Merged below so the
  // UI reflects your own actions immediately instead of waiting on a backend round-trip
  // that may never arrive.
  const [serverOrders, setServerOrders] = useState<Order[]>([]);
  const [pendingOrders, setPendingOrders] = useState<Order[]>([]);
  const [toast, setToast] = useState<string | null>(null);
  const [apiError, setApiError] = useState<string | null>(null);
  const [loadingMarket, setLoadingMarket] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [wsConnected, setWsConnected] = useState(false);
  const [marketAsks, setMarketAsks] = useState<MarketRow[]>(fixtureAsks);
  const [marketBids, setMarketBids] = useState<MarketRow[]>(fixtureBids);
  const [trades, setTrades] = useState<TradeEntry[]>(fixtureTrades);
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [addressCopied, setAddressCopied] = useState(false);
  const [makerLockHash, setMakerLockHash] = useState<string | null>(null);
  const [walletBalance, setWalletBalance] = useState<{ CKB: number; TOKEN: number }>({
    CKB: 0,
    TOKEN: 0,
  });

  const wsRef = useRef<WebSocket | null>(null);
  const wsChannelsRef = useRef<Set<string>>(new Set());
  const makerLockHashRef = useRef<string | null>(null);

  const { signerInfo, open, close: closeConnector, disconnect, client } = useCcc();
  const [useDevSigner, setUseDevSigner] = useState(false);
  const devSigner = useMemo(
    () => (devPrivateKey ? new ccc.SignerCkbPrivateKey(client, devPrivateKey) : undefined),
    [client],
  );
  const signer = useDevSigner ? devSigner : signerInfo?.signer;
  const connected = Boolean(signer && walletAddress);

  useEffect(() => {
    makerLockHashRef.current = makerLockHash;
  }, [makerLockHash]);

  useEffect(() => {
    if (!signer) {
      setWalletAddress(null);
      setMakerLockHash(null);
      setWalletBalance({ CKB: 0, TOKEN: 0 });
      return;
    }

    let cancelled = false;

    signer
      .getRecommendedAddressObj()
      .then((address) => {
        if (cancelled) return;
        setWalletAddress(address.toString());
        setMakerLockHash(address.script.hash());
        void fetchWalletBalance(address.script);
      })
      .catch(() => {
        if (cancelled) return;
        setWalletAddress(null);
        setMakerLockHash(null);
        setWalletBalance({ CKB: 0, TOKEN: 0 });
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signer]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 2600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  async function fetchWalletBalance(lock: ccc.Script) {
    try {
      const ckbBalance = await client.getBalanceSingle(lock);
      let tokenBalance = 0n;

      if (xudtType) {
        for await (const cell of client.findCellsByLock(lock, xudtType, true)) {
          tokenBalance += ccc.udtBalanceFrom(cell.outputData);
        }
      }

      setWalletBalance({
        CKB: Number(ccc.fixedPointToString(ckbBalance)),
        TOKEN: Number(tokenBalance),
      });
    } catch {
      setWalletBalance({ CKB: 0, TOKEN: 0 });
    }
  }

  // --- Realtime backend connection (falls back to REST polling if the socket is down) ---
  useEffect(() => {
    if (!marketReady) {
      void refreshMarketData();
      return;
    }

    let cancelled = false;
    let pollTimer: number | undefined;
    let reconnectTimer: number | undefined;

    function startPolling() {
      if (pollTimer !== undefined) return;
      void refreshMarketData();
      pollTimer = window.setInterval(() => void refreshMarketData(), 5000);
    }

    function stopPolling() {
      if (pollTimer !== undefined) {
        window.clearInterval(pollTimer);
        pollTimer = undefined;
      }
    }

    function connect() {
      if (cancelled) return;

      const socket = new WebSocket(wsBase);
      wsRef.current = socket;

      socket.onopen = () => {
        if (cancelled) return;
        setWsConnected(true);
        stopPolling();

        const channels = [`market:${xudtTypeHash}:orderbook`, `market:${xudtTypeHash}:trades`];
        if (makerLockHashRef.current) {
          channels.push(`maker:${makerLockHashRef.current}:orders`);
        }
        wsChannelsRef.current = new Set(channels);
        socket.send(JSON.stringify({ channels }));
      };

      socket.onmessage = (event) => {
        try {
          handleRealtimeMessage(JSON.parse(event.data as string));
        } catch {
          // ignore malformed frames
        }
      };

      socket.onerror = () => {
        setWsConnected(false);
      };

      socket.onclose = () => {
        if (cancelled) return;
        setWsConnected(false);
        startPolling();
        reconnectTimer = window.setTimeout(connect, 4000);
      };
    }

    connect();

    return () => {
      cancelled = true;
      stopPolling();
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      wsRef.current?.close();
      wsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Subscribe to (and eagerly REST-fetch) this wallet's own orders once it's known.
  useEffect(() => {
    if (!makerLockHash) {
      setServerOrders([]);
      setPendingOrders([]);
      return;
    }

    wsSubscribe([`maker:${makerLockHash}:orders`]);
    void refreshMyOrders(makerLockHash);
  }, [makerLockHash]);

  // Local orders (just placed/cancelled) are kept until the backend reports the same
  // status for the same id - at which point the backend's version is authoritative and
  // the local placeholder is no longer needed.
  useEffect(() => {
    setPendingOrders((previous) =>
      previous.filter((pending) => {
        const fromServer = serverOrders.find((order) => order.id === pending.id);
        return !(fromServer && fromServer.status === pending.status);
      }),
    );
  }, [serverOrders]);

  const mergedOrders = useMemo(() => {
    const byId = new Map<string, Order>();
    for (const order of serverOrders) byId.set(order.id, order);
    // Pending (local) entries win over the server's version of the same id - the server
    // may simply not know about the action yet (e.g. the bot hasn't indexed/matched it).
    for (const order of pendingOrders) byId.set(order.id, order);
    return Array.from(byId.values()).sort((a, b) => b.time.getTime() - a.time.getTime());
  }, [serverOrders, pendingOrders]);

  const openOrders = useMemo(
    () => mergedOrders.filter((order) => order.status === "Open" || order.status === "Pending"),
    [mergedOrders],
  );
  const history = useMemo(
    () => mergedOrders.filter((order) => order.status === "Filled" || order.status === "Cancelled"),
    [mergedOrders],
  );

  function wsSubscribe(channels: string[]) {
    const toAdd = channels.filter((channel) => !wsChannelsRef.current.has(channel));
    if (toAdd.length === 0) return;
    toAdd.forEach((channel) => wsChannelsRef.current.add(channel));

    const socket = wsRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ channels: toAdd }));
    }
  }

  function handleRealtimeMessage(message: {
    type?: string;
    channel?: string;
    data?: unknown;
  }) {
    if (message.type === "error" || !message.channel || !Array.isArray(message.data)) return;

    if (message.channel.endsWith(":orderbook")) {
      // Apply the pushed book as-is, including a legitimately empty one (e.g. right after
      // the only resting orders fill) - gating on non-empty here would silently drop that
      // update and leave stale rows on screen until something else happened to refetch.
      const mapped = normalizeOrderBook(message.data as ApiOrderItem[]);
      setMarketAsks(mapped.asks);
      setMarketBids(mapped.bids);
      setApiError(null);
      return;
    }

    if (message.channel.startsWith("market:") && message.channel.endsWith(":trades")) {
      setTrades(normalizeTrades(message.data as ApiTradeItem[]));
      return;
    }

    if (message.channel.startsWith("maker:") && message.channel.endsWith(":orders")) {
      applyMyOrders(message.data as ApiOrderItem[]);
    }
  }

  function applyMyOrders(items: ApiOrderItem[]) {
    setServerOrders(items.map(mapApiOrder));
  }

  async function refreshMyOrders(lockHash: string) {
    try {
      const response = await fetch(
        `${apiBase}/orders?makerLockHash=${encodeURIComponent(lockHash)}&limit=100`,
      );
      if (!response.ok) return;
      const payload = await response.json();
      applyMyOrders(payload?.data?.items ?? []);
    } catch {
      // leave existing state - the realtime channel or next poll will catch up
    }
  }

  const askRows = useMemo(() => {
    let cumulative = 0;
    const reversed = [...marketAsks].reverse();
    return reversed
      .map((row) => {
        cumulative += row.amount;
        return { ...row, cumulative };
      })
      .reverse();
  }, [marketAsks]);

  const bidRows = useMemo(() => {
    let cumulative = 0;
    return marketBids.map((row) => {
      cumulative += row.amount;
      return { ...row, cumulative };
    });
  }, [marketBids]);

  const maxDepth = Math.max(
    askRows[0]?.cumulative ?? 0,
    bidRows[bidRows.length - 1]?.cumulative ?? 0,
  );
  const bestAsk = marketAsks[marketAsks.length - 1]?.price ?? defaultMidPrice;
  const bestBid = marketBids[0]?.price ?? defaultMidPrice;
  const midPrice = (bestAsk + bestBid) / 2 || defaultMidPrice;
  const spread = bestAsk - bestBid;

  const totalValue = useMemo(() => {
    const priceValue = orderType === "limit" ? Number.parseFloat(priceInput) : midPrice;
    const amountValue = Number.parseFloat(amountInput);

    if (!priceValue || !amountValue || Number.isNaN(priceValue) || Number.isNaN(amountValue)) {
      return 0;
    }

    return priceValue * amountValue;
  }, [amountInput, midPrice, orderType, priceInput]);

  function showToast(message: string) {
    setToast(message);
  }

  function setOrderSide(nextSide: Side) {
    setSide(nextSide);
  }

  function setOrderTypeValue(nextType: OrderType) {
    setOrderType(nextType);
    if (nextType === "market") {
      setPriceInput("");
      return;
    }
    setPriceInput(String(defaultMidPrice));
  }

  function quickPercent(percent: number) {
    if (!signer) {
      showToast("Connect your wallet first");
      return;
    }

    const priceValue =
      orderType === "limit" ? Number.parseFloat(priceInput) || midPrice : midPrice;

    let amount = 0;
    if (side === "buy") {
      amount = priceValue > 0 ? (walletBalance.CKB * percent) / 100 / priceValue : 0;
    } else {
      amount = (walletBalance.TOKEN * percent) / 100;
    }

    setAmountInput(Math.floor(amount).toString());
  }

  async function refreshMarketData() {
    if (!marketReady) {
      setApiError(
        "No market token configured (set VITE_XUDT_ISSUER_LOCK_HASH). Showing local demo data.",
      );
      return;
    }

    setLoadingMarket(true);

    try {
      const [orderBookResponse, tradeResponse] = await Promise.all([
        fetch(`${apiBase}/order-book?xudtTypeHash=${xudtTypeHash}&limit=25`),
        fetch(`${apiBase}/trades?xudtTypeHash=${xudtTypeHash}&limit=5`),
      ]);

      if (!orderBookResponse.ok) {
        throw new Error(`Order book request failed (${orderBookResponse.status})`);
      }

      const orderBookPayload = await orderBookResponse.json();
      const tradePayload = tradeResponse.ok ? await tradeResponse.json() : null;

      const mappedBook = normalizeOrderBook(orderBookPayload?.data?.items ?? []);
      setMarketAsks(mappedBook.asks.length > 0 ? mappedBook.asks : fixtureAsks);
      setMarketBids(mappedBook.bids.length > 0 ? mappedBook.bids : fixtureBids);

      if (tradePayload?.data?.items?.length) {
        setTrades(normalizeTrades(tradePayload.data.items));
      }

      setApiError(null);
    } catch (error) {
      const message = formatError(error, "Unable to reach the backend market service.");
      setApiError(`${message} Showing local demo data instead.`);
      setMarketAsks(fixtureAsks);
      setMarketBids(fixtureBids);
      setTrades(fixtureTrades);
    } finally {
      setLoadingMarket(false);
    }
  }

  async function handleSubmit() {
    if (!signer) {
      open();
      return;
    }

    if (orderType === "market") {
      showToast("Market orders aren't supported by this DEX yet — use Limit");
      return;
    }

    if (!marketReady) {
      showToast("No market token configured — set VITE_XUDT_ISSUER_LOCK_HASH");
      return;
    }

    const amount = Number.parseFloat(amountInput);
    const priceValue = Number.parseFloat(priceInput);

    if (!amount || amount <= 0 || !Number.isInteger(amount)) {
      showToast("Enter a whole token amount");
      return;
    }

    if (!priceValue || priceValue <= 0) {
      showToast("Enter a price");
      return;
    }

    setSubmitting(true);
    try {
      const tokenAmount = BigInt(amount);
      const totalPrice = ccc.fixedPointFrom((priceValue * amount).toFixed(8));

      const tx = await buildCreateOrderTx({
        signer,
        client,
        side: side === "buy" ? SIDE_BUY : SIDE_SELL,
        tokenAmount,
        totalPrice,
      });

      const txHash = await signer.sendTransaction(tx);
      showToast(`${side === "buy" ? "Buy" : "Sell"} order submitted — ${shortHash(txHash)}`);
      setAmountInput("");

      const ownerLock = (await signer.getRecommendedAddressObj()).script;
      void fetchWalletBalance(ownerLock);
      setPendingOrders((previous) => [
        buildOptimisticOrder({ txHash, side, tokenAmount, totalPrice, tx, ownerLock }),
        ...previous,
      ]);
      if (makerLockHash) void refreshMyOrders(makerLockHash);
    } catch (error) {
      showToast(formatError(error, "Order submission failed"));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleCancelOrder(order: Order) {
    if (!signer || !order.raw) return;

    try {
      const tx = await buildCancelOrderTx({ signer, client, order: order.raw });
      const txHash = await signer.sendTransaction(tx);
      showToast(`Cancel submitted — ${shortHash(txHash)}`);
      setPendingOrders((previous) => [
        { ...order, status: "Cancelled" as OrderStatus, time: new Date() },
        ...previous.filter((pending) => pending.id !== order.id),
      ]);
      if (makerLockHash) void refreshMyOrders(makerLockHash);
    } catch (error) {
      showToast(formatError(error, "Cancel failed"));
    }
  }

  function toggleConnect() {
    if (useDevSigner) {
      setUseDevSigner(false);
      showToast("Dev key disconnected");
      return;
    }

    if (connected) {
      disconnect();
      closeConnector();
      showToast("Wallet disconnected");
      return;
    }

    open();
  }

  function connectDevSigner() {
    setUseDevSigner(true);
    showToast("Using dev private key (devnet only)");
  }

  async function copyAddress() {
    if (!walletAddress) return;
    try {
      await navigator.clipboard.writeText(walletAddress);
      setAddressCopied(true);
      window.setTimeout(() => setAddressCopied(false), 1500);
    } catch {
      showToast("Couldn't copy address");
    }
  }

  const availableText = connected
    ? side === "buy"
      ? `${fmtCkb(walletBalance.CKB)} CKB`
      : `${fmtAmount(walletBalance.TOKEN)} TOKEN`
    : "—";

  const submitLabel = !signer
    ? "Connect wallet"
    : submitting
      ? "Submitting…"
      : side === "buy"
        ? "Buy"
        : "Sell";

  return (
    <div className="app-shell">
      <header>
        <div className="header-left">
          <div className="logo">
            <span className="dot" />
            CKB order book
          </div>
          <span className="chain-badge">CKB {DEX_NETWORK}</span>
          <span className="chain-badge">{tradingPairLabel}</span>
        </div>

        <div className="header-right">
          <div id="headerBalance" className={connected ? "show" : ""}>
            <span>
              <b className="mono">{fmtAmount(walletBalance.TOKEN)}</b> TOKEN
            </span>
            <span>
              <b className="mono">{fmtCkb(walletBalance.CKB)}</b> CKB
            </span>
          </div>
          <div className="wallet-controls">
            <button
              type="button"
              id="connectBtn"
              className={connected ? "connected" : ""}
              onClick={() => void toggleConnect()}
            >
              {connected && walletAddress ? shortAddress(walletAddress) : "Connect wallet"}
            </button>
            {connected && walletAddress ? (
              <button
                type="button"
                className="copy-address-btn"
                title="Copy wallet address"
                aria-label="Copy wallet address"
                onClick={() => void copyAddress()}
              >
                {addressCopied ? <Check size={14} /> : <Copy size={14} />}
              </button>
            ) : null}
            {devSigner && !connected ? (
              <button
                type="button"
                className="dev-signer-btn"
                title="Connect with the devnet private key from VITE_DEV_PRIVATE_KEY"
                onClick={connectDevSigner}
              >
                Dev key
              </button>
            ) : null}
          </div>
        </div>
      </header>

      {apiError ? (
        <div className="api-alert" role="alert">
          <span>⚠</span>
          <span>{apiError}</span>
          <button type="button" onClick={() => setApiError(null)}>
            Dismiss
          </button>
        </div>
      ) : null}

      <div className="main">
        <div className="panel">
          <div className="panel-header">
            Order book
            {wsConnected ? (
              <span className="status-inline">Live</span>
            ) : loadingMarket ? (
              <span className="status-inline">Syncing…</span>
            ) : null}
          </div>
          <div className="panel-body">
            <div className="book-cols">
              <span>Price (CKB)</span>
              <span>Amount (TOKEN)</span>
              <span>Total</span>
            </div>

            <div id="asksBody">
              {askRows.map((row) => (
                <button
                  key={`${row.price}-${row.amount}`}
                  type="button"
                  className="book-row ask"
                  onClick={() => {
                    setOrderTypeValue("limit");
                    setOrderSide("buy");
                    setPriceInput(row.price.toFixed(6));
                  }}
                >
                  <div
                    className="depth-bar"
                    style={{ width: `${((row.cumulative ?? 0) / maxDepth) * 100}%` }}
                  />
                  <span className="mono red">{fmtPrice(row.price)}</span>
                  <span className="mono">{fmtAmount(row.amount)}</span>
                  <span className="mono muted">{fmtAmount(row.cumulative ?? 0)}</span>
                </button>
              ))}
            </div>

            <div className="spread-row">
              <span className="mono mid">{fmtPrice(midPrice)}</span>
              <span className="label">
                Spread {fmtPrice(spread)} ({((spread / midPrice) * 100).toFixed(2)}%)
              </span>
            </div>

            <div id="bidsBody">
              {bidRows.map((row) => (
                <button
                  key={`${row.price}-${row.amount}`}
                  type="button"
                  className="book-row bid"
                  onClick={() => {
                    setOrderTypeValue("limit");
                    setOrderSide("sell");
                    setPriceInput(row.price.toFixed(6));
                  }}
                >
                  <div
                    className="depth-bar"
                    style={{ width: `${((row.cumulative ?? 0) / maxDepth) * 100}%` }}
                  />
                  <span className="mono green">{fmtPrice(row.price)}</span>
                  <span className="mono">{fmtAmount(row.amount)}</span>
                  <span className="mono muted">{fmtAmount(row.cumulative ?? 0)}</span>
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="panel">
          <div className="panel-header">Place order</div>
          <div className="panel-body trade-panel-body">
            <div className="seg" id="sideSeg">
              <button
                type="button"
                className={side === "buy" ? "active buy" : "buy"}
                onClick={() => setOrderSide("buy")}
              >
                Buy
              </button>
              <button
                type="button"
                className={side === "sell" ? "active sell" : "sell"}
                onClick={() => setOrderSide("sell")}
              >
                Sell
              </button>
            </div>

            <div className="seg seg-type" id="typeSeg">
              <button
                type="button"
                className={orderType === "limit" ? "active" : ""}
                onClick={() => setOrderTypeValue("limit")}
              >
                Limit
              </button>
              <button
                type="button"
                className={orderType === "market" ? "active" : ""}
                onClick={() => setOrderTypeValue("market")}
              >
                Market
              </button>
            </div>

            <div className="field">
              <label>Price</label>
              <div className="input-wrap">
                <input
                  type="number"
                  step="0.00000001"
                  placeholder="0.00000000"
                  value={priceInput}
                  disabled={orderType === "market"}
                  onChange={(event) => setPriceInput(event.target.value)}
                />
                <span className="unit">CKB</span>
              </div>
            </div>

            <div className="field">
              <label>Amount</label>
              <div className="input-wrap">
                <input
                  type="number"
                  step="1"
                  min="1"
                  placeholder="0"
                  value={amountInput}
                  onChange={(event) => setAmountInput(event.target.value)}
                />
                <span className="unit">TOKEN</span>
              </div>
            </div>

            <div className="pct-row">
              {[25, 50, 75, 100].map((percent) => (
                <button key={percent} type="button" onClick={() => quickPercent(percent)}>
                  {percent}%
                </button>
              ))}
            </div>

            <div className="total-row">
              <span>Total</span>
              <span className="mono">{fmtCkb(totalValue)} CKB</span>
            </div>
            <div className="available-row">
              <span>Available</span>
              <span className="mono" id="availableLabel">
                {availableText}
              </span>
            </div>

            <button
              type="button"
              className={`submit-btn ${connected ? side : "neutral"}`}
              disabled={submitting}
              onClick={() => void handleSubmit()}
            >
              {submitLabel}
            </button>
          </div>
        </div>

        <div className="panel">
          <div className="panel-header">Market</div>
          <div className="panel-body market-panel-body">
            <div className="stat-price mono">{fmtPrice(midPrice)}</div>
            <div className="stat-grid">
              <div>
                24h high
                <b className="mono">0.008310</b>
              </div>
              <div>
                24h low
                <b className="mono">0.007890</b>
              </div>
              <div>
                Best ask
                <b className="mono">{fmtPrice(bestAsk)}</b>
              </div>
              <div>
                Best bid
                <b className="mono">{fmtPrice(bestBid)}</b>
              </div>
            </div>

            <div className="trade-list">
              <div className="trade-list-header">Recent trades</div>
              {trades.map((trade) => (
                <div key={`${trade.hash}-${trade.time}`} className="trade-row">
                  <span className={`trade-side ${trade.side}`}>
                    {trade.side === "buy" ? "Buy" : "Sell"}
                  </span>
                  <span className="mono">{trade.price}</span>
                  <span className="mono muted">{trade.amount}</span>
                  <span className="muted">{trade.time}</span>
                </div>
              ))}
            </div>

            <div className="divider" />
            <div className="panel-header small-header">Balances</div>
            <div id="balancesContent">
              {connected ? (
                <>
                  <div className="balance-row">
                    <span className="secondary">TOKEN</span>
                    <span className="mono amt">{fmtAmount(walletBalance.TOKEN)}</span>
                  </div>
                  <div className="balance-row">
                    <span className="secondary">CKB</span>
                    <span className="mono amt">{fmtCkb(walletBalance.CKB)}</span>
                  </div>
                </>
              ) : (
                <p className="muted">Connect your wallet to view balances.</p>
              )}
            </div>
          </div>
        </div>

        <div className="panel orders-panel">
          <div className="orders-tabs">
            <button
              type="button"
              className={activeTab === "open" ? "active" : ""}
              onClick={() => setActiveTab("open")}
            >
              Open orders <span className="muted">({openOrders.length})</span>
            </button>
            <button
              type="button"
              className={activeTab === "history" ? "active" : ""}
              onClick={() => setActiveTab("history")}
            >
              Order history
            </button>
          </div>

          {activeTab === "open" ? (
            <div id="openOrdersPanel">
              <table>
                <thead>
                  <tr>
                    <th>Pair</th>
                    <th>Side</th>
                    <th>Type</th>
                    <th>Price</th>
                    <th>Amount</th>
                    <th>Total</th>
                    <th>Time</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {!connected ? (
                    <tr className="empty-row">
                      <td colSpan={8}>Connect your wallet to see your open orders</td>
                    </tr>
                  ) : openOrders.length === 0 ? (
                    <tr className="empty-row">
                      <td colSpan={8}>No open orders</td>
                    </tr>
                  ) : (
                    openOrders.map((order) => (
                      <tr key={order.id}>
                        <td>{tradingPairLabel}</td>
                        <td className={`side-tag ${order.side === "buy" ? "green" : "red"}`}>
                          {order.side === "buy" ? "Buy" : "Sell"}
                        </td>
                        <td className="secondary">
                          {order.type === "limit" ? "Limit" : "Market"}
                        </td>
                        <td className="mono">{fmtPrice(order.price)}</td>
                        <td className="mono">{fmtAmount(order.amount)}</td>
                        <td className="mono">{fmtCkb(order.total)}</td>
                        <td className="muted">
                          {fmtTime(order.time)}
                          {order.status === "Pending" ? (
                            <span className="pending-tag" title="Submitted on-chain, waiting for the backend to index it">
                              Pending
                            </span>
                          ) : null}
                        </td>
                        <td>
                          <button
                            type="button"
                            className="cancel-btn"
                            onClick={() => void handleCancelOrder(order)}
                          >
                            Cancel
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          ) : (
            <div id="historyPanel">
              <table>
                <thead>
                  <tr>
                    <th>Pair</th>
                    <th>Side</th>
                    <th>Type</th>
                    <th>Price</th>
                    <th>Amount</th>
                    <th>Total</th>
                    <th>Status</th>
                    <th>Time</th>
                  </tr>
                </thead>
                <tbody>
                  {!connected ? (
                    <tr className="empty-row">
                      <td colSpan={8}>Connect your wallet to see your order history</td>
                    </tr>
                  ) : history.length === 0 ? (
                    <tr className="empty-row">
                      <td colSpan={8}>No order history yet</td>
                    </tr>
                  ) : (
                    history.map((order) => (
                      <tr key={`${order.id}-${order.status}`}>
                        <td>{tradingPairLabel}</td>
                        <td className={`side-tag ${order.side === "buy" ? "green" : "red"}`}>
                          {order.side === "buy" ? "Buy" : "Sell"}
                        </td>
                        <td className="secondary">
                          {order.type === "limit" ? "Limit" : "Market"}
                        </td>
                        <td className="mono">{fmtPrice(order.price)}</td>
                        <td className="mono">{fmtAmount(order.amount)}</td>
                        <td className="mono">{fmtCkb(order.total)}</td>
                        <td>
                          <span className={`status-tag ${order.status}`}>{order.status}</span>
                        </td>
                        <td className="muted">{fmtTime(order.time)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      <div id="toastHost">{toast ? <div className="toast">{toast}</div> : null}</div>
    </div>
  );
}

function mapOrderStatus(status?: string): OrderStatus {
  if (status === "FILLED") return "Filled";
  if (status === "CANCELED" || status === "CANCELLED") return "Cancelled";
  return "Open";
}

function shannonsToCkb(value: string | undefined): number {
  if (!value) return 0;
  try {
    return Number(ccc.fixedPointToString(BigInt(value)));
  } catch {
    return 0;
  }
}

// Built from a just-sent create-order transaction, before the backend has any idea it
// exists. buildCreateOrderTx always puts the order cell at output index 0 (see dex.ts),
// so its id already matches the id the backend will eventually assign to the same cell
// (outPoint.txHash:index) - the pendingOrders/serverOrders merge relies on that.
function buildOptimisticOrder(params: {
  txHash: string;
  side: Side;
  tokenAmount: bigint;
  totalPrice: bigint;
  tx: ccc.Transaction;
  ownerLock: ccc.Script;
}): Order {
  const { txHash, side, tokenAmount, totalPrice, tx, ownerLock } = params;
  const amount = Number(tokenAmount);
  const totalCkb = Number(ccc.fixedPointToString(totalPrice));
  const price = amount > 0 ? totalCkb / amount : totalCkb;
  const direction: CancelableOrder["direction"] = side === "sell" ? "ASK" : "BID";
  const ownerLockLike = {
    codeHash: ownerLock.codeHash,
    hashType: ownerLock.hashType,
    args: ownerLock.args,
  } as CancelableOrder["ownerLock"];

  return {
    id: `${txHash}:0`,
    side,
    type: "limit",
    price,
    amount,
    total: totalCkb,
    time: new Date(),
    status: "Pending",
    raw: {
      outPoint: { txHash, index: "0" } as CancelableOrder["outPoint"],
      direction,
      capacity: tx.outputs[0].capacity.toString(),
      ownerLock: ownerLockLike,
      typeScript: direction === "ASK" && xudtType
        ? ({
            codeHash: xudtType.codeHash,
            hashType: xudtType.hashType,
            args: xudtType.args,
          } as CancelableOrder["typeScript"])
        : undefined,
      cellData: tx.outputsData[0] as CancelableOrder["cellData"],
    },
  };
}

function mapApiOrder(doc: ApiOrderItem): Order {
  const amount = Number.parseFloat(doc.tokenAmount ?? doc.remainingAmount ?? "0") || 0;
  const totalCkb = shannonsToCkb(doc.pricePerToken);
  const price = amount > 0 ? totalCkb / amount : totalCkb;

  return {
    id: doc._id ?? `${doc.outPoint?.txHash}:${doc.outPoint?.index}`,
    side: doc.direction === "BID" ? "buy" : "sell",
    type: "limit",
    price,
    amount,
    total: totalCkb,
    time: doc.createdAt ? new Date(doc.createdAt) : new Date(),
    status: mapOrderStatus(doc.status),
    raw:
      doc.outPoint && doc.direction && doc.capacity && doc.ownerLock && doc.cellData
        ? {
            outPoint: doc.outPoint as CancelableOrder["outPoint"],
            direction: doc.direction,
            capacity: doc.capacity,
            ownerLock: doc.ownerLock as CancelableOrder["ownerLock"],
            typeScript: doc.typeScript as CancelableOrder["typeScript"],
            cellData: doc.cellData as CancelableOrder["cellData"],
          }
        : undefined,
  };
}

function normalizeOrderBook(items: ApiOrderItem[]) {
  const asks = items
    .filter((item) => item.direction === "ASK")
    .map((item) => {
      const amount = Number.parseFloat(item.remainingAmount ?? item.tokenAmount ?? "0") || 0;
      const totalCkb = shannonsToCkb(item.pricePerToken);
      return { price: amount > 0 ? totalCkb / amount : totalCkb, amount };
    })
    .filter((row) => row.price > 0 && row.amount > 0)
    .slice(0, 8)
    .sort((left, right) => right.price - left.price);

  const bids = items
    .filter((item) => item.direction === "BID")
    .map((item) => {
      const amount = Number.parseFloat(item.remainingAmount ?? item.tokenAmount ?? "0") || 0;
      const totalCkb = shannonsToCkb(item.pricePerToken);
      return { price: amount > 0 ? totalCkb / amount : totalCkb, amount };
    })
    .filter((row) => row.price > 0 && row.amount > 0)
    .slice(0, 8)
    .sort((left, right) => right.price - left.price);

  return { asks, bids };
}

function normalizeTrades(items: ApiTradeItem[]): TradeEntry[] {
  return items.slice(0, 4).map((item, index) => {
    const amount = Number.parseFloat(item.tokenAmount ?? "0") || 0;
    const totalCkb = shannonsToCkb(item.price);
    const price = amount > 0 ? totalCkb / amount : totalCkb;

    return {
      time: item.createdAt
        ? new Date(item.createdAt).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
          })
        : `12:${String((index + 1) * 4).padStart(2, "0")}:00`,
      price: price.toFixed(6),
      amount: amount.toLocaleString(undefined, { maximumFractionDigits: 2 }),
      side: index % 2 === 0 ? "buy" : "sell",
      hash: item.settlementTxHash
        ? `${item.settlementTxHash.slice(0, 6)}...${item.settlementTxHash.slice(-4)}`
        : `0x${index.toString(16).padStart(4, "0")}...${index.toString(16)}`,
    };
  });
}

function formatError(error: unknown, fallback: string) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return fallback;
}

function shortAddress(address: string) {
  if (!address) return "wallet";
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function shortHash(hash: string) {
  return `${hash.slice(0, 10)}...${hash.slice(-6)}`;
}

function fmtPrice(value: number) {
  return value.toFixed(6);
}

function fmtAmount(value: number) {
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function fmtCkb(value: number) {
  return value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtTime(date: Date) {
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export default App;
