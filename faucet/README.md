# Faucet

A small, standalone service that drips the demo xUDT token to testnet addresses. It is separate from `backend/` so the issuer private key never lives next to the DEX API's config or database.

Each claim mints new supply (owner-mode xUDT: an input with the issuer's lock authorizes minting), so there is no pooled token balance to run out. The issuer account only needs **testnet CKB**, which pays each output's capacity and the transaction fee. Top it up from a public testnet CKB faucet.

**Testnet only.** The service refuses to start with any `CKB_NETWORK` other than `testnet`.

## How a claim works

1. `POST /api/v1/faucet/claim` with an address. The address must be valid for the configured network.
2. In one atomic step the faucet reserves the address's cooldown and a share of the global daily budget (claim count and token amount). If the address is cooling down, already has a claim in flight, or the daily budget is spent, it is rejected before anything is sent.
3. It builds, signs and sends the mint transaction. Sends are serialized by a lock so concurrent claims never pick the same issuer cells.
4. If the send fails, the cooldown and budget reservations are rolled back. A reservation that never reaches "sent" is treated as abandoned after 5 minutes.

On startup the faucet verifies the chain and deployment manifest, and checks that the issuer key matches the issuer baked into the token's type script. A wrong key fails at boot.

## Requirements

- Node.js 22+ (or Bun) and MongoDB 7. The faucet uses its own database, `ckb-dex-faucet`. A standalone MongoDB is enough here.
- The issuer private key for the demo token. It must be the key that created the token.
- The issuer address funded with testnet CKB.
- `../deployment/manifest.json` and `../shared/`. Run from a full checkout.

## Configuration

Copy `.env.example` to `.env`.

| Variable | Default | Description |
| --- | --- | --- |
| `FAUCET_ISSUER_PRIVATE_KEY` | none, **required** | `0x`-prefixed secp256k1 private key of the token issuer. Treat as a secret. |
| `MONGO_DB_URL` | none, **required** | MongoDB connection string. |
| `CKB_RPC_URL` | none, **required** | CKB testnet RPC, for example `https://testnet.ckb.dev`. |
| `CKB_NETWORK` | `testnet` | Only `testnet` is accepted. |
| `PORT` | `3100` | HTTP port. |
| `FAUCET_DRIP_AMOUNT` | `100` | Tokens minted per claim (positive integer, in token base units). |
| `FAUCET_COOLDOWN_HOURS` | `24` | Time before the same address can claim again. |
| `FAUCET_DAILY_MAX_CLAIMS` | `500` | Global claims per UTC day. |
| `FAUCET_DAILY_MAX_TOKENS` | drip x max claims | Global tokens per UTC day. Must be at least one drip. |

Invalid values stop the service at startup with an explanatory error.

## Run locally

```bash
cd faucet
npm install            # or: bun install
cp .env.example .env   # set FAUCET_ISSUER_PRIVATE_KEY
npm run dev            # watch mode on :3100
```

| Script | Purpose |
| --- | --- |
| `npm run dev` | Run with `tsx watch` |
| `npm run build` | Compile to `dist/` |
| `npm start` | Run the compiled build |
| `npm run typecheck` | Type-check without emitting |
| `npm test` | Run tests (in-memory MongoDB, no external services) |

## API

Base path `/api/v1/faucet`. Requests are JSON with a 4 KB body limit.

### `GET /health`

```json
{ "message": "Faucet is healthy", "data": { "drip": "100", "claimsToday": 3, "dailyMaxClaims": 500 } }
```

### `POST /claim`

```bash
curl -X POST localhost:3100/api/v1/faucet/claim \
  -H 'content-type: application/json' \
  -d '{"address":"ckt1q..."}'
```

Success returns `{ "data": { "txHash": "0x...", "amount": "100" } }`. The tokens appear once the transaction is committed.

| Status | Meaning |
| --- | --- |
| 400 | Missing, malformed, or wrong-network address |
| 409 | A claim for this address is already in progress |
| 429 | This address is on cooldown (the message says how many seconds remain), or the per-IP throttle hit (one request per 5 seconds per IP) |
| 503 | Daily claim or token budget exhausted; try again after 00:00 UTC |
| 500 | Send failed. Reservations are rolled back, so the caller can retry. |

The per-IP throttle is in memory and resets on restart. The database-backed per-address cooldown and daily budgets are the real limits.

## Deployment

### Docker Compose (recommended)

From the **repository root**:

```bash
cp faucet/.env.example faucet/.env     # set FAUCET_ISSUER_PRIVATE_KEY
docker compose up -d --build faucet
```

This also starts the `database` service it depends on. Compose overrides `NODE_ENV=production` and `MONGO_DB_URL` (to `mongodb://database:27017/ckb-dex-faucet?replicaSet=rs0`), so `MONGO_DB_URL` in `.env` only matters outside Compose. To run backend and faucet together, use `docker compose up -d --build`.

Verify:

```bash
curl localhost:3100/api/v1/faucet/health
docker compose logs -f faucet
```

### Faucet image on its own

The build context is the repository root:

```bash
docker build -f faucet/Dockerfile -t ckb-dex-faucet .
docker run -d --name ckb-dex-faucet -p 3100:3100 \
  --env-file faucet/.env \
  -e NODE_ENV=production \
  -e MONGO_DB_URL='mongodb://<host>:27017/ckb-dex-faucet' \
  ckb-dex-faucet
```

The image runs as a non-root user and shuts down cleanly on `SIGTERM`.

### Production checklist

- **Run one instance.** The send lock and IP throttle are in process memory. The claim records live in MongoDB, so persist that volume. Losing it resets cooldowns and daily budgets.
- **Protect the issuer key.** Inject `FAUCET_ISSUER_PRIVATE_KEY` from a secret store, keep `.env` out of git (it is gitignored), and use a dedicated testnet-only key.
- **Fund the issuer.** Watch its CKB balance. Claims fail with a 500 when it runs dry.
- **Terminate TLS in a reverse proxy.** The per-IP throttle uses `req.ip`, which is the proxy's address unless Express `trust proxy` is configured (not enabled in the code today). Behind a proxy, enforce per-client limits there as well.
- **Set CORS and limits deliberately.** The service allows any origin (`cors()`); restrict at the proxy if the faucet should only serve your UI.
- **Lower the daily limits** (`FAUCET_DAILY_MAX_CLAIMS`, `FAUCET_DAILY_MAX_TOKENS`) to what the issuer's CKB balance can cover. Each claim costs the output capacity plus the fee.
- Do not publish MongoDB's port, and enable authentication outside demos.

## Layout

```text
src/
  index.ts           startup, graceful shutdown
  app.ts             Express app
  config.ts          env parsing; rejects non-testnet
  routes/index.ts    /health and /claim, per-IP throttle
  services/
    faucet.ts        deployment checks, tx build/sign/send
    claims.ts        atomic cooldown + daily budget reservations
    db.ts            MongoDB connection
  models/            claim and budget Mongoose models
  utils/mutex.ts     serializes sends
```
