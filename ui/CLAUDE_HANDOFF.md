# LucentDex — handoff context for Claude

Written 2026-11-11 to hand this work to a new Claude session. Read it fully before
changing anything. It covers what the project is, how it works, the decisions already
made (and why), the current state, and what comes next.

> Not part of the product. Don't commit this file in a PR unless the team wants it.

---

## 1. What we're building and the goal

**LucentDex** is the web UI of `ckb-dex`, an order-book DEX on **Nervos CKB testnet**.
Users trade one market, **TOKEN / CKB** (an xUDT token), with their own wallets.

The goal of this work: a **polished, trustworthy trading UX on testnet**, using the
team's deployed backend and faucet:
- one-click wallet connection (JoyID first),
- a clear review before every order, with exact amounts and fees,
- a live market (order book, chart, stats, balances),
- order states that agree everywhere, and the ability to cancel at any time,
- plain-language errors, and an app that never looks stuck.

**Scope decisions the user has made (don't reopen):**
- **Testnet only.** Devnet support was removed from the UI on purpose.
- **The UI uses the deployed backend and faucet**, not local ones.
- **Spot exchange wording: Buy / Sell**, never Long / Short.
- **The team's backend, faucet and offchain logic are not ours to change.** Only change
  them when the user explicitly asks.

---

## 2. Working with this user

- **Answer-only requests:** "explain, don't edit", "answer before you do anything", "just
  answer the question", "don't code". When they say this, explain only and change no files.
- **Confirm before destructive or outward-facing steps:** git overwrites, deleting data,
  pushing, posting. When they asked to overwrite local changes, a backup branch was made
  first. Keep doing that.
- **They run things themselves on Windows** (Git Bash and WSL). Give commands that work in
  Git Bash. npm runs scripts with `cmd.exe` on Windows (see Gotchas).
- **They test by pasting browser console output, notifications and backend logs.** UI
  errors are logged as `[LucentDex] <action> failed`.
- **Secrets:** never ask them to paste private keys. Several devnet and test keys were
  pasted in the old session, so treat any key seen in chat as compromised and recommend
  fresh ones. `.env` files can't be read by Claude in auto mode (the permission classifier
  blocks it); ask for the non-secret lines, or grep only specific safe keys.

---

## 3. Repository

GitHub: `https://github.com/LucentLabss/ckb-dex` (monorepo). Local checkout:
`C:\Users\USER\Desktop\Workspace\LUCENT_LABS\ckb-dex`.

| Folder | What it is | Owner |
| --- | --- | --- |
| `ui/` | **LucentDex**, the React UI. This handoff is about this folder. | us |
| `backend/` | Express + MongoDB API, realtime WebSocket, matching bot (TypeScript, bun) | team |
| `faucet/` | Standalone xUDT faucet service (mints TOKEN per claim) | team |
| `offchain/` | CLI scripts: `issue-token`, `create-order`, `fill-order` | team |
| `shared/` | `deployment.mjs` (manifest loader + chain checks), `settlement-capacity.mjs` | team |
| `deployment/` | `manifest.json` (**source of truth** for contracts and token), `scripts.json`, migrations | team |
| `smart-contract/` | Rust contracts, incl. `contracts/dex-order-lock` | team |

**Deployed services the UI uses by default:**
- API: `https://api.72.62.119.247.sslip.io/api/v1`
- WebSocket: `wss://api.72.62.119.247.sslip.io`
- Faucet: `https://faucet.72.62.119.247.sslip.io/api/v1/faucet` (1,000 TOKEN per claim at last check)
- CKB RPC: `https://testnet.ckb.dev` (public; sometimes slow, see Gotchas)

All three allow CORS from any origin.

---

## 4. How the system works

### 4.1 The order contract (`dex-order-lock`)
An order is a cell locked by the DEX lock. **Order args = 90 bytes:**
`version(1)=1 | side(1): 0=buy, 1=sell | makerLockHash(32) | xudtTypeHash(32) | tokenAmount(u128 LE) | price(u64 LE)`.

- **`price` is the total CKB (shannons) for the whole `tokenAmount`**, not a per-token rate.
  The UI takes a per-token price and multiplies.
- **Buy order:** a plain CKB cell (no type) holding at least price + the buyer's future token
  cell + a fee reserve. At settlement the buyer gets a token cell, and leftover CKB beyond the
  fee goes back into that token cell. The fee is capped at `MAX_SETTLEMENT_FEE` = 10,000 shannons.
- **Sell order:** a cell with the xUDT type holding exactly `tokenAmount`. Its CKB deposit
  (~216 CKB, because the 90-byte lock is large) is paid back to the seller with the price at
  settlement.
- **Matching is all-or-nothing:** a buy and a sell match only with the **same token, same
  `tokenAmount` and same total `price`**. There are no partial fills.
- **Cancel:** spend the order cell in a transaction that also has an input with the
  maker's lock. The refund must keep the order cell's type and data and at least its full
  capacity. The fee comes from the separate maker input (`validate_cancellation`).
- **Contract error codes** are mapped to plain language in `ui/src/utils/errors.js`, including −26
  (buyer leftover not returned) and −27 (cancellation refund).
- **The contract changes over time.** Orders made under an old code hash are not recognised by
  a new one. `main` currently has code hash `0x2c1cb808…` (deployed 2026-11-02). The local `ui`
  branch still has the older `0x8560b80b…` manifest (see §7).

### 4.2 Deployment manifest
`deployment/manifest.json`, read through `shared/deployment.mjs`, holds the network identity
(including the testnet genesis hash), the DEX script and its cell deps, known system scripts
(including XUdt), and **assets**. The market token is asset `demo`, symbol **TOKEN**, with args
= issuer lock hash `0x81a4bc69…12e4` + `00000000`.

The UI imports the manifest directly (Vite `server.fs.allow: [".."]`), so **a manifest update
on `main` reaches the UI with no UI code change**.

### 4.3 Backend (read-only from the UI)
- REST:
  - `/order-book?xudtTypeHash=…` (LIVE orders only),
  - `/orders?makerLockHash=&xudtTypeHash=&status=`,
  - `/orders/:txHash/:index`,
  - `/trades`, `/markets`, `/readiness`.

  Responses are `{ message, data: { items, nextCursor }, status }`. Page size is at most 200.
- WebSocket: send `{ "channels": [...] }`. Channels are `market:<typeHash>:orderbook`,
  `market:<typeHash>:trades` and `maker:<lockHash>:orders`. Each gets a snapshot, then a full
  snapshot on every update (bounded to about 100 rows). At most 8 channels per message and
  16 per connection.
- Order statuses: `LIVE` → `RESERVED` → `PENDING` / `SETTLEMENT_SUBMITTED` → `FILLED`. Also
  `CANCELED`/`CANCELLED`, `INVALID`, `ORPHANED`.
- **Timing:** the bot polls every 5 s. The backend only indexes blocks `CONFIRMATION_DEPTH`
  (default **10**) deep. Testnet produces a block about every **8.3 s**.
  - An order shows as LIVE about 1½–2 min after it's sent.
  - With a matching order already in the book, **placing to "Order filled" takes about
    3½–4½ min**. Lowering `CONFIRMATION_DEPTH` on the server would cut that; it's the
    team's call.
- When the bot sends a settlement, the order **drops out of the LIVE book**. It only becomes
  **FILLED once the settlement is 10 blocks deep**. The UI bridges that gap (§5.4).

### 4.4 Faucet
`POST {FAUCET_URL}/claim` with `{ address }` returns `{ data: { txHash, amount } }`. Errors:
- 400: wrong network or address
- 409: a claim is already in flight
- 429: cooldown; the message contains `try again in <N>s`
- 503: the daily budget is used up

It mints with the issuer key, which lives only in the faucet, and pays the token cell's
~146–150 CKB itself.

---

## 5. The UI (`ui/`)

**Stack:** React 18, Vite 5, React Router 6, `@ckb-ccc/connector-react` 2.2.2 (CCC core 1.23),
plain JSX (no TypeScript), the DM Sans font. Dark theme, with colour tokens in `src/styles/variables.css`.

### 5.1 File map
| Path | Responsibility |
| --- | --- |
| `src/main.jsx` | `StartupGate` → providers (Toast → Wallet → Market) → `App` |
| `src/config/env.js` | `VITE_*` settings with deployed defaults |
| `src/services/ckb/client.js` | Manifest-based CKB client (pinned scripts, no fallbacks); `verifyChain()` (cached per session); `dexScript`, `xudtCellDeps`, `marketTokenType` |
| `src/services/ckb/token.js` | Market token from the manifest; token balance from cells |
| `src/services/ckb/dex.js` | Order lock args; create-order and cancel builders; `walletDelta` (plain-CKB and token effect of a tx); `sellOrderDeposit`; `readOwnOrderCell` (read your own order from the chain); `SETTLEMENT_FEE_RESERVE` = 2 × `MAX_SETTLEMENT_FEE` |
| `src/services/api/*` | `http.js` (envelope unwrap, `ApiError`), `market.js`, `realtime.js` (one shared WebSocket, reconnects with backoff), `faucet.js` |
| `src/services/pendingOrders.js` | Submitted-but-not-yet-indexed orders per wallet, kept in localStorage (30 min max) |
| `src/services/closedOrders.js` | **Shared store of filled/cancelled orders**: the single signal for fill sync |
| `src/context/WalletContext.jsx` | CCC Provider (JoyID pinned first and labelled "· Recommended", Khie hidden); address and lock; balances with **optimistic deltas** until the tx commits; `trackTransaction` |
| `src/context/MarketContext.jsx` | Order book and trades (REST + WebSocket); holds orders that leave the LIVE book as **settling** until closed; pair stats |
| `src/context/ToastContext.jsx` | Top-right notifications (`notify`, `notifyError`), auto-close, pause on hover |
| `src/hooks/useOrders.js` | Your orders; status-change notifications; **background builds** (`prebuildOrder`/`prepareOrder`); `placeOrder` (separate **signing** and **sending** stages); `cancelOrder` (including early cancel) |
| `src/hooks/useOrderForm.js` | Form state, validation, the default price (market price), and the 600 ms trigger for background builds |
| `src/hooks/useFaucet.js` | "Get TOKEN" claim and cooldown |
| `src/components/trade/*` | `OrderPanel`, `OrderConfirmModal` (review sheet), `OrderBook`, `OpenOrders` (with the Action column), `PairBar`, `ChartCard`/`PriceChart` |
| `src/components/common/StartupGate.jsx` | Startup chain check (ported from the team's TSX), with Try again |
| `src/utils/errors.js` | `describeError` (plain language), `logError`, `logAction`, `UserError` |
| `src/utils/orders.js` | Order drafts and validation, funds checks, backend doc → table row, status labels |
| `src/utils/chart.js` | Candles from trades, `paddedRange`, bounded `niceTicks` |

### 5.2 Key flows
- **Startup:** `StartupGate` runs `verifyChain()` (genesis matches the manifest, DEX and xUDT
  code cells are live) with a 20 s timeout, and shows Try again if it fails.
- **Placing an order:**
  1. The form validates the order, then after a 600 ms pause hands it to `prebuildOrder`.
  2. The background build is cached by side, amount, price, lock and balances. Sending
     anything clears the cache.
  3. The review sheet calls `prepareOrder`, which reuses that build or starts one.
  4. Until the exact numbers are ready, the sheet shows estimates marked **≈**, with a status
     line and spinners.
  5. "Fulfil order" signs (shows "Approve in wallet…"), then sends (shows "Sending…").
  6. The order is added to the pending store, and `trackTransaction` applies its balance
     change straight away.
- **Fill sync:** `closedOrders` is fed by trades (both sides of each trade), the wallet's own
  order channel, and backend status checks of held orders. The order book, Open orders and the
  "Order filled" notice all read it, so they change in the same render.
- **Cancel:**
  - A **Cancel** button appears in the Open orders Action column.
  - For a just-placed order the backend hasn't listed yet, `readOwnOrderCell` reads output 0 of
    the order transaction from the chain (checking it's your DEX order). That allows a cancel
    about 15–30 s after placing.
  - Matched (settling) orders show "Matched" and can't be cancelled.
- **Balances** only count plain CKB cells (CCC `getBalance`). CKB held in order or token cells
  isn't counted, which the review sheet explains ("Leaves your wallet", "You receive when filled").

### 5.3 Terminology and UX conventions
- Order sides are **Buy / Sell** everywhere, in the UI and in internal values (`"buy"`/`"sell"`
  in the form, `"Buy"`/`"Sell"` on rows). The contract's side byte: buy = 0, sell = 1.
- Statuses in Open orders: Submitted, Open, Settling, Cancelling; Filled goes to history.
- Notifications: a short title plus one plain sentence; technical detail goes to the console.
- Header: Logo · `TESTNET` badge · Trade · (Get TOKEN, Get CKB ↗) · the wallet button with
  address, TOKEN and CKB balances.

### 5.4 Configuration (`ui/.env.local` is optional)
`VITE_API_URL`, `VITE_WS_URL`, `VITE_FAUCET_URL`, `VITE_CKB_RPC_URL`, `VITE_XUDT_DECIMALS`.
All default to the deployed services and testnet; an empty value counts as unset.
`VITE_DEX_NETWORK`, `VITE_XUDT_ISSUER_LOCK_HASH` and `VITE_DEV_PRIVATE_KEY` are **no longer used**.

---

## 6. History: what was done, in order

1. Built LucentDex (originally a separate `lucentdex` folder): CCC wallet connection, order
   panel, review sheet, toasts, trade-based chart, order book, pair bar.
2. Connected it to the backend and the on-chain order builders, ported from the team's old `ui/src/lib/dex.ts`.
3. Many devnet issues (OffCKB resets wiped the chain and contracts; the stuck `28114` proxy;
   the CCC client silently falling back to the public testnet). The user then chose **testnet only**.
4. The user **overwrote local changes with `origin/main`** (the team's TypeScript UI, a hardened
   backend, the faucet, the manifest, a new contract). Local work was saved first on the
   **local-only branch `backup/ui-local-2026-10-30`**.
5. **LucentDex restored into `ui/`** and adapted to `main`: manifest client, new contract rules,
   faucet button, team `StartupGate` ported to JSX, team logo kept, deployed URLs as defaults.
6. UX work: background builds, ≈ estimates, loading states; fill sync via `closedOrders`;
   the Action column with early cancel; slow-RPC timeouts no longer misreported as a wallet
   rejection; a fix for a chart **infinite loop** (float-equal prices made `niceTicks` step
   below float precision).
7. **Merged to `main` via PR #19** (commit `504c251`, "modify ui, create token faucet and add error messages").
8. Renamed Long/Short to **Buy/Sell** everywhere. **Uncommitted** (§7).
9. Deliverables outside the repo: a PR description, social media posts, and a Claude Docs page
   "LucentDex UI/UX Improvements". These used Buy/Sell except the early PR text (it said
   Long/Short; the corrected wording was given in chat).

---

## 7. Current state (as of 2026-11-11)

- Local branch **`ui`** = `origin/ui` at **`504c251`**, which is already in `main`.
- **Uncommitted on `ui`:** the Buy/Sell rename, 9 files:
  - `ui/README.md`
  - `src/components/trade/OpenOrders.jsx`, `OrderConfirmModal.jsx`, `OrderPanel.jsx`
  - `src/context/MarketContext.jsx`
  - `src/hooks/useOrderForm.js`
  - `src/services/pendingOrders.js` (maps legacy saved "Long"/"Short" rows to Buy/Sell)
  - `src/styles/components.css` (`.sell` classes)
  - `src/utils/orders.js`

  It builds; the rename is checked in the browser.
- **`main` is ahead of `ui`:**
  - **new DEX deployment:** code hash `0x2c1cb8086484…`, tx `0xff891c8764…`;
  - **bun for the UI:** `ui/bun.lock` added, `ui/package-lock.json` removed, CI runs
    `bun install --frozen-lockfile && bun run build`;
  - a repo cleanup and README updates (including a "Redeploying the contract" guide).
- **Not yet tested with a real wallet:**
  - a faucet claim to a JoyID wallet,
  - placing a buy and a sell,
  - a fill end to end,
  - cancelling (both normal and early),
  - the signing UX in JoyID.

---

## 8. Next steps

1. **Bring `ui` up to date with `main`, keeping the rename:**
   - Either commit the rename, then merge `origin/main` into `ui`,
   - or stash it, merge, then re-apply.

   Expect `main`'s deletion of `ui/package-lock.json` and the bun switch: use **bun**
   (`bun install`, `bun run dev`, `bun run build`), and don't re-add `package-lock.json`. The UI
   picks up the new contract automatically from the manifest.
2. **Run the UI** (`cd ui && bun install && bun run dev`) and check the startup gate passes on
   the new manifest.
3. **End-to-end test with JoyID on testnet:**
   1. Get TOKEN, then Get CKB.
   2. Place a buy and a sell.
   3. Match by clicking a book row and using the **same amount**.
   4. Watch "settling" → "Order filled" happen in sync.
   5. Cancel an open order, and a just-placed one.
4. **Commit the rename and open a PR** to `main`, using the PR description with Buy/Sell
   wording. Only commit or push when the user asks.
5. **Optional improvements**, the user's call:
   - a faster RPC endpoint (`VITE_CKB_RPC_URL`),
   - a lower backend `CONFIRMATION_DEPTH` (server setting),
   - code splitting (the main bundle is about 950 KB),
   - a pre-submit "you need X CKB" check for sells,
   - restoring some type checking.

---

## 9. Gotchas and lessons

- **Public RPC slowness:** `testnet.ckb.dev` has taken 7–22 s for a single call at times. The
  startup gate then shows "Couldn't connect to CKB"; Try again works once it recovers. Timeouts
  show as "The network is slow", never as a wallet rejection.
- **CCC fallbacks:** `ClientPublicTestnet` silently adds public testnet RPC fallbacks unless
  `fallbacks: []` is passed. That once mixed two chains in one transaction. The manifest client
  (`createDeploymentClient`) already passes `fallbacks: []`.
- **Float prices:** equal prices can differ by one ULP (`0.00814` vs `0.008140000000000001`).
  Never loop on a float step without a bound; see `paddedRange` / `niceTicks`.
- **Windows:** npm runs scripts in `cmd.exe`, so POSIX `NAME=value cmd` scripts fail (the
  backend `dev` script uses `NODE_OPTIONS=…`). Run the command in Git Bash, or use
  `--script-shell` with bash. A stray Vite process can lock `node_modules/@esbuild/…/esbuild.exe`
  and make clean installs fail; check for leftover dev servers. Port 3000 is sometimes taken by
  an unrelated local Next.js site.
- **Contract migrations orphan old orders.** After a redeploy, the backend DB must be cleared and
  both the code hash and the cell-dep `txHash` updated in `manifest.json` (see `main`'s README).
- **`offchain/src/shared.ts` builds an outdated 40-byte DEX lock**, so `npm run create-order`
  orders are invalid for the contract. UI orders are fine. That's the team's code; it was left as is.
- **Balances:** a buy moves ~146–150 CKB into the token cell you'll receive, and a sell locks a
  ~216 CKB deposit (more if a leftover-token cell is needed). That's expected behaviour, and
  the review sheet explains it.

---

## 10. Pointers

- PR description, social posts and the detailed feature write-up were produced in the old chat.
  The Claude Docs page "LucentDex UI/UX Improvements" was created in the old account.
  Ask the user for links or text if needed; it may not be shared with the new account.
- The local-only backup of pre-overwrite work: branch `backup/ui-local-2026-10-30`. It's not
  needed for current work.
