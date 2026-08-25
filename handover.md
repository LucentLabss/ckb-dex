# CKB DEX Bot Developer Handover

## Purpose

This handover describes the backend that is ready for bot integration in the CKB DEX proof of concept. It is a single-order xUDT sell-order flow: the bot observes CKB state, the backend maintains a queryable projection, and the UI reads that projection and signs buyer-funded settlement transactions.

CKB remains the source of truth. MongoDB is only a backend read model. Do not write MongoDB directly from the bot.

## Current Backend Status

Milestones 1 through 4 are implemented and verified. Milestone 5 is intentionally deferred and does not block bot integration.

Implemented backend capabilities:

- Express API with health and readiness probes.
- MongoDB-backed order, trade, and ingestion-event projections.
- Authenticated internal bot-event ingestion.
- Zod validation for all supported bot event payloads.
- Event-id deduplication and persisted ingestion audit records.
- Enforced order lifecycle transitions.
- Reorg handling that marks affected orders as `ORPHANED`.
- REST read APIs for markets, order books, order detail/history, and trades.
- WebSocket broadcasts for market and maker-specific projection updates.

The backend does not index CKB, select orders, construct settlement transactions, sign transactions, or hold user keys. Those responsibilities belong to the bot and UI.

## Backend Configuration You Need

Obtain these values from the backend operator:

- `BACKEND_BASE_URL`, for example `http://localhost:3000`
- `API_VERSION`, currently `1`
- `INTERNAL_BOT_TOKEN`
- Configured DEX lock-script metadata and target CKB network

The bot event endpoint is:

```text
POST {BACKEND_BASE_URL}/api/v1/internal/events
```

Every request must include one of:

```http
Authorization: Bearer {INTERNAL_BOT_TOKEN}
```

or:

```http
x-internal-bot-token: {INTERNAL_BOT_TOKEN}
```

Also send:

```http
Content-Type: application/json
```

## Your Responsibilities

The bot must:

1. Index CKB transactions and cells.
2. Identify eligible cells using the configured DEX lock and supported xUDT type scripts.
3. Decode the DEX lock arguments and cell data.
4. Treat every order as a full `SELL` order only. Partial fills, buy orders, market orders, and atomic matching of multiple DEX order cells are outside the POC contract.
5. Rank currently available sell orders by `totalAskCapacity`, using the agreed chain-order tie-breakers.
6. Build a settlement transaction for exactly one selected order and return it for the buyer to sign.
7. Observe submission, confirmation, cancellation, and reorganization outcomes on CKB.
8. Emit normalized events to the backend endpoint described above.

## Event Delivery Rules

Events are at-least-once. The backend is deliberately tolerant of retries and some out-of-order delivery.

Every event must include:

```json
{
  "schemaVersion": 1,
  "eventId": "globally-unique-and-stable-id",
  "occurredAt": "2026-08-24T12:00:00.000Z",
  "transactionHash": "0x...",
  "blockNumber": "12345",
  "blockHash": "0x...",
  "confirmations": 1
}
```

Rules:

- `eventId` must be globally unique. Use a deterministic ID where possible, such as event type, transaction hash, outpoint, and block number.
- Do not reuse an `eventId` for distinct events.
- All CKB quantities, outpoint indexes, and block numbers must be JSON strings. Do not send JavaScript numbers for chain values.
- `occurredAt` must be an ISO 8601 date-time.
- Terminal events (`order-cancelled` and `trade-confirmed`) require confirmation evidence: either `confirmations > 0`, or both `blockNumber` and `blockHash`.
- Retrying the same event is safe. It will return `IGNORED` with reason `duplicate-event-id` after the first successful processing.

## Supported Events

### `order-confirmed`

Send this when an eligible order cell is confirmed and should become `LIVE`.

```json
{
  "schemaVersion": 1,
  "eventId": "order-confirmed:0xORDER_TX:0:100",
  "occurredAt": "2026-08-24T12:00:00.000Z",
  "transactionHash": "0xORDER_TX",
  "blockNumber": "100",
  "blockHash": "0xBLOCK_HASH",
  "confirmations": 1,
  "eventType": "order-confirmed",
  "outPoint": { "txHash": "0xORDER_TX", "index": "0" },
  "order": {
    "orderCellLockHash": "0x...",
    "dexLockArgs": "0x...",
    "typeScriptHash": "0x...",
    "xudtTypeHash": "0x...",
    "makerLockHash": "0x...",
    "makerAddress": "optional-address",
    "tokenAmount": "1000",
    "orderCapacity": "10000000000",
    "totalAskCapacity": "2500000000",
    "createdAtTxHash": "0xORDER_TX",
    "createdAtBlock": "100"
  }
}
```

`totalAskCapacity` is the full CKB payment required to consume the order cell, in shannons. It is not a token unit price.

### `settlement-submitted`

Send this after a settlement transaction has been submitted, but before it is confirmed. It changes the order to `SETTLEMENT_SUBMITTED`; it must not be treated as a fill.

```json
{
  "schemaVersion": 1,
  "eventId": "settlement-submitted:0xSETTLEMENT_TX:0xORDER_TX:0",
  "occurredAt": "2026-08-24T12:01:00.000Z",
  "eventType": "settlement-submitted",
  "outPoint": { "txHash": "0xORDER_TX", "index": "0" },
  "settlementTxHash": "0xSETTLEMENT_TX"
}
```

### `trade-confirmed`

Send this only once the settlement is canonical under the agreed confirmation policy. It marks the order `FILLED` and creates an immutable trade projection.

```json
{
  "schemaVersion": 1,
  "eventId": "trade-confirmed:0xSETTLEMENT_TX:200",
  "occurredAt": "2026-08-24T12:02:00.000Z",
  "transactionHash": "0xSETTLEMENT_TX",
  "blockNumber": "200",
  "blockHash": "0xBLOCK_HASH",
  "confirmations": 1,
  "eventType": "trade-confirmed",
  "outPoint": { "txHash": "0xORDER_TX", "index": "0" },
  "trade": {
    "settlementTxHash": "0xSETTLEMENT_TX",
    "makerLockHash": "0x...",
    "buyerLockHash": "0x...",
    "xudtTypeHash": "0x...",
    "tokenAmount": "1000",
    "totalAskCapacity": "2500000000",
    "orderCapacity": "10000000000",
    "paidCapacity": "12500000000",
    "confirmedAtBlock": "200"
  }
}
```

### `order-cancelled`

Send this when the order cell has been consumed by maker cancellation and that cancellation has confirmation evidence.

```json
{
  "schemaVersion": 1,
  "eventId": "order-cancelled:0xCANCEL_TX:0xORDER_TX:0",
  "occurredAt": "2026-08-24T12:03:00.000Z",
  "transactionHash": "0xCANCEL_TX",
  "blockNumber": "210",
  "blockHash": "0xBLOCK_HASH",
  "confirmations": 1,
  "eventType": "order-cancelled",
  "outPoint": { "txHash": "0xORDER_TX", "index": "0" },
  "cancelledByTxHash": "0xCANCEL_TX"
}
```

### `chain-reorg`

Send this when the bot detects a reorganization that invalidates previously observed projection state.

```json
{
  "schemaVersion": 1,
  "eventId": "chain-reorg:0xREVERTED_BLOCK_HASH",
  "occurredAt": "2026-08-24T12:04:00.000Z",
  "eventType": "chain-reorg",
  "revertedBlockHash": "0xREVERTED_BLOCK_HASH",
  "revertedBlockNumber": "210",
  "reason": "optional description"
}
```

The current backend marks affected order projections as `ORPHANED`. Full trade reconciliation after a reorg is deferred to milestone 5.

## Expected Event Ordering and Outcomes

Preferred flow:

```text
order-confirmed -> settlement-submitted -> trade-confirmed
```

The backend accepts retries and protects against illegal transitions. In particular:

- Duplicate events return `IGNORED`.
- Events for unknown order outpoints return `IGNORED`.
- Unconfirmed cancellation or trade events return `IGNORED`.
- Invalid order state transitions return `IGNORED` or a processing failure, depending on the event path.
- A successful HTTP response contains an ingestion result with `APPLIED` or `IGNORED`.
- A `400` response means the event failed schema validation.
- A `401` response means the bot token was missing or invalid.
- A `500` response should be retried using the same `eventId` after the transient cause is resolved.

## REST and WebSocket Integration

The bot does not need to call the read APIs; it populates the projections that power them. The UI consumes:

```text
GET /api/v1/markets
GET /api/v1/order-book?xudtTypeHash={typeHash}
GET /api/v1/orders/{txHash}/{index}
GET /api/v1/orders?makerLockHash={makerLockHash}&status={status}
GET /api/v1/trades?xudtTypeHash={typeHash}
GET /api/v1/health
GET /api/v1/readiness
```

After accepted projection changes, the backend WebSocket broadcaster can publish updates for:

```text
market:{xudtTypeHash}:orderbook
market:{xudtTypeHash}:trades
maker:{makerLockHash}:orders
```

## What To Confirm Before Implementation

Please confirm these points with the backend and smart-contract owners:

- The exact DEX lock-script code hash, hash type, arguments, dependencies, and network.
- Exact lock-argument decoding and ask-price units.
- xUDT data layout and minimum order-cell capacity.
- The finality threshold used by the bot before it sends cancellation and trade confirmation events.
- The available-order ranking tie-breakers after `totalAskCapacity`.
- The reorg checkpoint/replay strategy.
- The concrete payload fixture for each event type before connecting to a production-like environment.

## Repository References

- `backend/src/schemas/bot-events.ts`: authoritative event payload validation.
- `backend/src/services/event-ingestion.ts`: lifecycle and event-application behavior.
- `backend/src/routes/internal.ts`: authenticated ingestion route.
- `backend/src/routes/market.ts`: REST read API behavior.
- `backend/src/services/realtime.ts`: WebSocket channel behavior.
- `guide.md`: backend milestones 1 to 3 integration notes.
- `BACKEND_IMPLEMENTATION_PLAN.md`: architecture, boundaries, and POC constraints.
