# Backend

Express + MongoDB service for the CKB DEX. It does four things:

- **Matching bot**: polls the chain every 5 seconds, indexes DEX Order Cells, finds exact buy/sell pairs and submits settlement transactions.
- **Event ingestion**: the bot posts domain events to `POST /internal/events`. Each event is schema-validated, verified on-chain, and applied to the order/trade projection in a MongoDB transaction.
- **Read API**: paginated REST endpoints for markets, the order book, orders and trades.
- **WebSocket broadcaster**: pushes order book, trade and maker-order updates on the same port.

Indexing waits for `CONFIRMATION_DEPTH` blocks and keeps checkpoints so it can recover from reorgs.

## Requirements

- Node.js 22+ (the Docker image uses `node:22-alpine`) or Bun
- MongoDB 7 **running as a replica set**. Ingestion uses transactions, which standalone MongoDB does not support. A single-node replica set is enough.
- A CKB RPC endpoint (default `https://testnet.ckb.dev`)
- `../deployment/manifest.json` and `../shared/`. The backend reads the contract deployment from the repo root, so run it from a full checkout.

## Configuration

Copy `.env.example` to `.env`.

| Variable | Default | Description |
| --- | --- | --- |
| `INTERNAL_BOT_TOKEN` | none, **required** | Secret that guards `/internal/*`. At least 32 characters; placeholders such as `changeme` and repeated characters are rejected. Generate with `openssl rand -hex 32`. |
| `MONGO_DB_URL` | `mongodb://127.0.0.1:27017/ckb-dex` | Connection string. Must point at a replica set. |
| `CKB_NETWORK` | `testnet` | `devnet`, `testnet` or `mainnet`. A network with no entry in `deployment/manifest.json` is rejected at startup. |
| `CKB_RPC_URL` | `https://testnet.ckb.dev` | CKB node RPC. |
| `PORT` | `3000` | HTTP and WebSocket port. |
| `CONFIRMATION_DEPTH` | `10` | Blocks a transaction must be buried under before it is indexed. |
| `API_VERSION` | `1` | Sets the base path, `/api/v<N>`. |
| `NODE_ENV` | `development` | `production` or `development`. |

The DEX order lock script comes from the deployment manifest. The legacy `CKB_DEX_SCRIPT_*` variables may still be set, but startup fails if they disagree with the manifest.

## Run locally

```bash
cd backend
npm install            # or: bun install
cp .env.example .env   # set INTERNAL_BOT_TOKEN
npm run dev            # watch mode on :3000
```

### MongoDB must be a replica set

The backend applies each ingested event (for example a trade that fills two orders, or a reorg rollback) in one MongoDB transaction, so a crash can never leave an order book half-updated. MongoDB only supports transactions on a replica set, so a plain standalone `mongod` fails at the first poll cycle:

```text
DexOrderBot poll cycle failed: MongoServerError: Transaction numbers are only allowed on a replica set member or mongos
```

A single-node replica set is enough. Pick one:

**A. Docker (separate instance, leaves any existing MongoDB alone)**

```bash
docker run -d --name ckb-dex-mongo -p 27018:27017 mongo:7 --replSet rs0 --bind_ip_all
docker exec ckb-dex-mongo mongosh --eval "rs.initiate({_id:'rs0',members:[{_id:0,host:'localhost:27017'}]})"
```

```text
MONGO_DB_URL=mongodb://127.0.0.1:27018/ckb-dex?replicaSet=rs0&directConnection=true
```

**B. Convert your local `mongod` (Linux, systemd)**

```bash
sudo tee -a /etc/mongod.conf <<'EOF'

replication:
  replSetName: rs0
EOF
sudo systemctl restart mongod
mongosh --eval "rs.initiate({_id:'rs0',members:[{_id:0,host:'127.0.0.1:27017'}]})"   # one time
```

```text
MONGO_DB_URL=mongodb://127.0.0.1:27017/ckb-dex?replicaSet=rs0&directConnection=true
```

This applies to every database on that server. Existing data is kept, and other projects keep working, but they now connect to a replica set.

**C. Run everything with `docker compose up`**, which already starts MongoDB as a replica set.

Always keep `directConnection=true` for a local single-node set. Check it worked with `mongosh --eval "rs.status().ok"`, which should print `1`.

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | Run with `tsx watch` |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run the compiled build (`node dist/index.js`) |
| `npm run typecheck` | Type-check without emitting |
| `npm test` | Run all tests (`tsx --test "src/**/*.test.ts"`). Tests use `mongodb-memory-server`, so no external database is needed. |
| `npm run test:schemas` | Run the bot event schema tests only |

## API

Base path `/api/v1`.

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/`, `/health` | none | Service info and liveness |
| GET | `/readiness` | none | `200` once the database is connected, otherwise `503` |
| GET | `/markets` | none | Known xUDT type hashes |
| GET | `/order-book` | none | Live orders, best price first. Filters: `xudtTypeHash`, `direction` (`ASK`/`BID`) |
| GET | `/orders` | none | Orders, newest first. Filters: `xudtTypeHash`, `makerLockHash`, `direction`, `status` |
| GET | `/orders/:txHash/:index` | none | One order by outpoint (`404` if unknown) |
| GET | `/trades` | none | Confirmed trades, excluding reverted ones. Filter: `xudtTypeHash` |
| POST | `/internal/events` | bot token | Ingest a bot event |

- List endpoints take `limit` (1-200, default 25) and an opaque `cursor`. Pass the response's `nextCursor` to get the next page.
- Public reads are limited to 300 requests per minute per client IP and return `429` with `Retry-After` beyond that. The limiter is in memory, per instance.
- Invalid input returns `400`. Every response carries an `x-request-id` header (your own is echoed back if you send one).
- `/internal/*` accepts `Authorization: Bearer <token>` or `X-Internal-Bot-Token: <token>`. Request bodies are capped at 128 KB.

### WebSocket

Same port as HTTP. Send `{ "channels": ["..."] }` and receive a `snapshot` followed by `update` messages. Channels:

- `market:<0xhash>:orderbook`
- `market:<0xhash>:trades`
- `maker:<0xhash>:orders`

Limits: 4 KiB per message, 8 channels per message, 16 per connection, 20 connections per IP, 1000 total. Snapshots hold at most 100 rows; page further over REST.

## Deployment

### Docker Compose (recommended)

From the **repository root** (the images need `deployment/` and `shared/`):

```bash
cp backend/.env.example backend/.env    # set INTERNAL_BOT_TOKEN
cp faucet/.env.example faucet/.env      # see faucet/README.md
docker compose up -d --build
```

`compose.yml` starts MongoDB 7 as a single-node replica set (initialized by its healthcheck), then the backend and the faucet. It overrides `NODE_ENV=production` and `MONGO_DB_URL` for the container, so those values in `.env` are ignored there. Data is kept in the `mongo-data` volume.

Verify:

```bash
curl localhost:3000/api/v1/readiness
docker compose logs -f backend
```

Update with `git pull && docker compose up -d --build backend`.

### Backend image on its own

The build context is the repository root:

```bash
docker build -f backend/Dockerfile -t ckb-dex-backend .
docker run -d --name ckb-dex-backend -p 3000:3000 \
  --env-file backend/.env \
  -e NODE_ENV=production \
  -e MONGO_DB_URL='mongodb://<host>:27017/ckb-dex?replicaSet=rs0' \
  ckb-dex-backend
```

The image runs as a non-root user and handles `SIGTERM` gracefully: it stops the bot, closes WebSockets, drains HTTP and disconnects from MongoDB.

### Production checklist

- **Run one instance.** The bot and the rate limiters keep state in memory. Two replicas would run two matching bots and have separate rate-limit counters.
- **Put it behind a TLS-terminating reverse proxy** (nginx, Caddy, a cloud load balancer) and forward WebSocket upgrades. Rate limiting uses `req.ip`, which is the proxy's address unless Express `trust proxy` is configured. This is not enabled in the code today.
- **Do not expose `/api/v1/internal/*` publicly** if you can avoid it. Block it at the proxy, or rely on the bearer token only if you must.
- **Keep `.env` out of git** (it is gitignored) and use a secret store where you can. Rotate `INTERNAL_BOT_TOKEN` by changing it and restarting.
- **Use a managed or backed-up MongoDB replica set.** The default compose setup is a single node with no auth and is fine for a demo, not for production data. Do not publish port 27017.
- **Monitor** `/api/v1/readiness` and watch logs for ingestion failures and reorg recovery.
- Use a reliable RPC provider for `CKB_RPC_URL`. The public testnet endpoint is rate limited.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `Transaction numbers are only allowed on a replica set member or mongos`, repeated on every poll cycle | MongoDB is running standalone. Convert it to a replica set, see [MongoDB must be a replica set](#mongodb-must-be-a-replica-set). Wiping the database does not help. |
| `MONGO_DB_URL` works but the server can't connect after enabling replication | The URL is missing `replicaSet=rs0&directConnection=true`, or `rs.initiate` was never run. |
| `Missing required environment variable: INTERNAL_BOT_TOKEN` or `must be at least 32 characters` | Set a real token: `openssl rand -hex 32`. |

## Layout

```text
src/
  index.ts          startup, graceful shutdown
  app.ts            Express app and route wiring
  config.ts         env parsing and validation
  bot/              chain polling, matching, settlement, checkpoints
  routes/           market (public) and internal (bot ingestion)
  schemas/          zod schemas for bot events
  services/         DB, event ingestion/verification, chain verifier, WebSocket broadcaster
  models/           Mongoose models: order, trade, checkpoint, ingestion event
  middleware/       request id, bot auth, rate limiter, error handler
```
