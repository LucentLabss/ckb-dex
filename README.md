# CKB DEX PoC

This repository contains a proof of concept for an exact-fill order book on
Nervos CKB. Makers create buy or sell Order Cells. A matching bot finds a
compatible pair and submits one transaction that consumes both orders.

Makers sign when they create or cancel their orders. Matching is
permissionless: no maker signature is required to settle a valid pair.

## Order model

The PoC supports full exact matches only. A buy and sell order must specify the
same xUDT type, token amount, and total CKB price.

```text
Buy order:  maker locks enough CKB for the price and buyer token Cell
Sell order: maker locks the exact xUDT amount

Match:
  seller receives the price plus the sell Order Cell capacity
  buyer receives the exact xUDT amount
```

Each match consumes exactly one buy Order Cell and one sell Order Cell. The
contract validates both sides. A maker can cancel an order by including a
maker-locked input in a transaction that consumes only that one DEX Order Cell.

## Order lock arguments

The current version uses exactly 90 bytes:

| Bytes | Size | Meaning |
| --- | ---: | --- |
| `0` | 1 byte | Format version, currently `1` |
| `1` | 1 byte | Side: `0` for buy, `1` for sell |
| `2..34` | 32 bytes | Maker lock script hash |
| `34..66` | 32 bytes | Expected xUDT type script hash |
| `66..82` | 16 bytes | Exact token amount as little-endian `u128` |
| `82..90` | 8 bytes | Total CKB price in shannons as little-endian `u64` |

The lock args record the terms the contract must enforce. The maker lock hash
commits to the complete maker lock script. A matcher may recover the full lock
from the order creation transaction's input Cells, then verify its hash against
the value in the args.

## Script responsibilities

| Component | Responsibility |
| --- | --- |
| DEX order lock | Enforces buy and sell terms, exact pair matching, and maker cancellation |
| xUDT type script | Enforces token validity and token conservation |
| Maker lock | Authenticates order creation and cancellation inputs |
| Matching bot | Discovers orders, selects matching pairs, builds and submits settlement transactions |

The bot is not trusted to enforce settlement. The DEX lock scripts and xUDT
type script validate the transaction on-chain.

## Scope and limitations

This PoC supports:

- xUDT buy and sell orders paid in CKB.
- Exact full fills with equal token type, amount, and price.
- One buy order and one sell order per settlement transaction.
- Permissionless matching and settlement.
- Maker-authorized cancellation of one order.

It does not support partial fills, price improvement, matching orders with
differing amounts, multi-order settlement, or a global on-chain order book.
The matching bot and off-chain services provide order discovery and matching.

## Architecture

Architecture design diagram: [Excalidraw](https://excalidraw.com/#json=6T6a0P16RtBe1zRh_G19a,FNWRx5FKMgarTLgrD7gdEA)

```text
 ┌──────────┐  REST + WebSocket   ┌──────────────────────────┐   ┌─────────┐
 │  ui/     │◄───────────────────►│ backend/                 │◄─►│ MongoDB │
 │ React +  │                     │  Express API + WS        │   └─────────┘
 │ CCC      │                     │  Matching bot (poll 5s)  │
 └────┬─────┘                     │  Event ingestion         │
      │ sign + broadcast          └───────────┬──────────────┘
      │ orders / cancels                      │ index cells, build and
      │                                       │ submit settlement txs
      ▼                                       ▼
 ┌───────────────────────────────────────────────────────┐
 │ CKB testnet (RPC)                                     │
 │  dex-order-lock · xUDT type script · maker locks      │
 └───────────────────────────────────────────────────────┘
      ▲
      │ mint test xUDT
 ┌────┴─────┐
 │ faucet/  │  (own MongoDB database, per-IP throttle, 24h cooldown)
 └──────────┘
```

Flow:

1. A maker creates a buy or sell Order Cell from the UI (or `offchain/` scripts),
   signing with their wallet. The cell is locked by `dex-order-lock`.
2. The backend bot polls the chain, indexes Order Cells into MongoDB, and
   recovers each maker's full lock from the creating transaction.
3. The bot finds an exact buy/sell pair, reserves both orders, builds the
   settlement transaction, and submits it. No maker signature is needed.
4. Order state changes are ingested as events and pushed to the UI over
   WebSocket (market and maker channels), with an initial snapshot on subscribe.
5. The chain, not the bot, enforces correctness through the lock and xUDT scripts.

Order statuses in the database: `DISCOVERED`, `LIVE`, `RESERVED`, `PENDING`,
`SETTLEMENT_SUBMITTED`, `FILLED`, `CANCELED`/`CANCELLED`, `INVALID`, `ORPHANED`.
The UI shows these as Broadcasting, Open, Matched, Submitted, Filled, Cancelled
and Invalid.

## Repository layout

| Path | Contents |
| --- | --- |
| `smart-contract/` | Rust CKB contracts (`dex-order-lock`, `lock-script-contract`) and tests |
| `backend/` | Express + MongoDB API, matching bot, event ingestion, WebSocket broadcaster |
| `ui/` | Vite + React 19 trading UI using CCC wallet connector |
| `faucet/` | Express service that drips test xUDT with a per-claim cooldown |
| `offchain/` | CLI scripts: `issue-token`, `create-order`, `fill-order` |
| `deployment/` | Deployed testnet script info (`scripts.json`) and system scripts |
| `compose.yml` | Docker Compose for MongoDB, backend and faucet |
| `weekly-progress-logs/` | Weekly progress reports |

## UI features

- Wallet connection, buy/sell forms with a review modal before signing.
- Order book with depth chart, recent trades, open orders and history tables
  with a lifecycle Status column.
- Live updates over WebSocket; distinct loading, empty and demo states.
- Persisted light/dark theme.
- Test token faucet integration.

## Backend API

Base path `/api/v1`.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/`, `/health`, `/readiness` | Service info and health |
| GET | `/markets` | Available markets |
| GET | `/order-book` | Aggregated bids and asks |
| GET | `/orders`, `/orders/:txHash/:index` | List or fetch orders |
| GET | `/trades` | Trade history |
| POST | `/internal/events` | Bot event ingestion (bearer-token protected) |

WebSocket (same port): clients send `{ "channels": [...] }` and receive a
`snapshot`, then `update` messages per channel.

The faucet exposes `GET /api/v1/health` and `POST /api/v1/claim` on port 3100.

## Deployed contracts (testnet)

`deployment/scripts.json` holds the code hash, hash type and cell deps.
`dex-order-lock` uses code hash
`0x8560b80bacb96bad676ce0c75b73ebf93e3a6fb06cda5cf3a89137f11018df3b`
(`data2`).

## Getting started

Requirements: Node.js, MongoDB (or Docker), Rust toolchain for contracts.

Each service has a `.env.example`; copy it to `.env` and fill in values.

```bash
# Database + backend + faucet
docker compose up --build

# Or run locally, per service (backend, faucet, ui)
cd backend && npm install && npm run dev      # API on :3000
cd faucet  && npm install && npm run dev      # faucet on :3100
cd ui      && npm install && npm run dev      # Vite dev server

# Off-chain helper scripts (need MAKER_PRIVATE_KEY / BUYER_PRIVATE_KEY)
cd offchain && npm install
npm run issue-token
npm run create-order
```

Key environment variables:

| Service | Variables |
| --- | --- |
| backend | `MONGO_DB_URL`, `PORT`, `CKB_RPC_URL`, `CKD_DEX_SCRIPT_CODE_HASH`, `CKB_DEX_SCRIPT_HASH_TYPE`, `CKB_DEX_SCRIPT_ARGS` |
| faucet | `MONGO_DB_URL`, `PORT`, `CKB_RPC_URL`, `FAUCET_ISSUER_PRIVATE_KEY`, `FAUCET_DRIP_AMOUNT`, `FAUCET_COOLDOWN_HOURS` |
| ui | `VITE_API_URL`, `VITE_WS_URL`, `VITE_CKB_RPC_URL`, `VITE_DEX_NETWORK`, `VITE_XUDT_ISSUER_LOCK_HASH`, `VITE_FAUCET_URL` |

The backend needs MongoDB reachable at startup; its "demo mode" fallback does
not work reliably yet.

## Smart contract development

Smart contract source, build instructions, and tests are in `smart-contract/`.
The DEX lock's validation details and error codes are documented in
[`smart-contract/contracts/dex-order-lock/README.md`](smart-contract/contracts/dex-order-lock/README.md).

From `smart-contract/`, build the DEX contract with:

```bash
make run CONTRACT=dex-order-lock TASK=build
```

Run its tests with:

```bash
cargo test -p tests test_dex_
```

Backend tests: `cd backend && npm test` (type check with `npm run typecheck`).
UI: `npm run lint` and `npm run build`.

## Known limitations

- Cancellation detected on-chain outside the bot's flow updates the database
  directly rather than through event ingestion, so it triggers no live UI update.
- The backend demo-mode fallback is non-functional.
- No partial fills, market orders, or multi-order atomic matching.
