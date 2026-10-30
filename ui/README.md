# LucentDex

```
npm install
npm run dev
```

Runs on **CKB testnet** (public RPC; JoyID and other CKB wallets) against the
**deployed** ckb-dex backend (`https://api.72.62.119.247.sslip.io`) and faucet
(`https://faucet.72.62.119.247.sslip.io`), so no local services or `.env.local`
are needed. To use other instances, e.g. a local backend, set the overrides in
`.env.local` (see `.env.example`).

The DEX contract, xUDT script and market token come from the shared deployment
manifest (`ckb-dex/deployment/manifest.json`, read through
`ckb-dex/shared/deployment.mjs`), the same one the backend, faucet and offchain
scripts use. On start the app checks the RPC is on that chain and the contracts
are live before showing anything.

src/
- pages/        route-level screens (TradePage, PlaceholderPage)
- components/   layout/ (shell), trade/ (dashboard panels, OrderConfirmModal), common/ (reusable bits, StartupGate)
- context/      WalletContext (CCC wallet connection, JoyID first; balances), MarketContext (order book, trades, stats), ToastContext
- config/       env.js (VITE_* settings)
- services/
  - api/        backend REST client (http, market), realtime WebSocket, faucet client
  - ckb/        CKB client and manifest, market token, dex-order-lock create/cancel tx builders
- hooks/        useOrders (maker orders + place/cancel), useOrderForm, useCandles, useFaucet, usePendingOrders
- utils/        format, chart math, order drafts and backend row mapping, error messages
- styles/       variables, layout, components CSS

Orders: Long = buy the token with CKB, Short = sell held token for CKB. The
contract matches all-or-nothing on identical amount and total price.
