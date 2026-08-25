# Backend Implementation Guide (Milestones 1 to 3)

## Scope

This guide summarizes what has been implemented so far for backend milestones 1, 2, and 3, the assumptions made in the code, and what the bot developer needs to provide for successful integration.

The current product scope is a proof of concept for single-order xUDT sell settlement.

## Milestone 1: Foundation Hardening (Implemented)

### Implemented

- Backend startup now waits for MongoDB connection before listening.
- Graceful shutdown path disconnects MongoDB without forcing process exit inside DB service.
- Request context middleware adds request IDs and returns x-request-id in responses.
- Centralized error handling returns consistent error envelopes.
- Health and readiness endpoints are live.
- Route construction uses proper Express Router creation.
- Environment parsing was hardened with required-variable and numeric validation.

### Primary files

- backend/src/index.ts
- backend/src/services/db.ts
- backend/src/types/db.ts
- backend/src/middleware/index.ts
- backend/src/app.ts
- backend/src/config.ts
- backend/src/routes/index.ts
- backend/src/utils/shared.ts

## Milestone 2: Event and Projection Contract (Implemented)

### Implemented

- Event schemas defined with Zod for bot event validation.
- Event naming standardized to kebab-case.
- Ingestion event model added for idempotency and audit.
- Order projection model aligned to POC constraints.
- Trade projection model added as immutable settlement record.
- Schema fixture tests added and passing.

### Primary files

- backend/src/schemas/bot-events.ts
- backend/src/schemas/bot-events.test.ts
- backend/src/schemas/index.ts
- backend/src/models/ingestion-event.ts
- backend/src/models/order.ts
- backend/src/models/trade.ts
- backend/src/models/index.ts
- backend/package.json

## Milestone 3: Idempotent Ingestion and Lifecycle Handling (Implemented Baseline)

### Implemented

- Internal ingestion endpoint added.
- Internal endpoint authentication added.
- Authentication accepts either:
  - Authorization: Bearer <token>
  - x-internal-bot-token: <token>
- Event ingestion service processes all current event types.
- Duplicate event IDs are ignored.
- Event processing result is persisted to ingestion audit collection.
- Order lifecycle transitions are enforced.
- Reorg events mark affected orders as ORPHANED.

### Primary files

- backend/src/routes/internal.ts
- backend/src/services/event-ingestion.ts
- backend/src/middleware/index.ts
- backend/src/app.ts
- backend/src/config.ts
- backend/src/types/config.ts

## Event Contract Expected from Bot

The backend expects POST requests to:

- /api/v{API_VERSION}/internal/events

The request must include one valid auth header:

- Authorization: Bearer value_of_INTERNAL_BOT_TOKEN
- or x-internal-bot-token: value_of_INTERNAL_BOT_TOKEN

### Supported eventType values

- order-confirmed
- order-cancelled
- settlement-submitted
- trade-confirmed
- chain-reorg

### Base fields expected on every event

- schemaVersion = 1
- eventId (globally unique)
- occurredAt (ISO datetime string)
- optional transactionHash
- optional blockNumber (string)
- optional blockHash
- optional confirmations (non-negative integer)

### Payload expectations by event

order-confirmed
- outPoint.txHash
- outPoint.index
- order.orderCellLockHash
- order.dexLockArgs
- order.typeScriptHash
- order.xudtTypeHash
- order.makerLockHash
- order.tokenAmount
- order.orderCapacity
- order.totalAskCapacity
- order.createdAtTxHash
- optional order.createdAtBlock

order-cancelled
- outPoint.txHash
- outPoint.index
- cancelledByTxHash
- Must carry confirmation proof through confirmations > 0, or both blockNumber and blockHash

settlement-submitted
- outPoint.txHash
- outPoint.index
- settlementTxHash

trade-confirmed
- outPoint.txHash
- outPoint.index
- trade.settlementTxHash
- trade.makerLockHash
- trade.buyerLockHash
- trade.xudtTypeHash
- trade.tokenAmount
- trade.totalAskCapacity
- trade.orderCapacity
- trade.paidCapacity
- trade.confirmedAtBlock
- Must carry confirmation proof through confirmations > 0, or both blockNumber and blockHash

chain-reorg
- revertedBlockHash
- revertedBlockNumber
- optional reason

## Lifecycle Rules Currently Enforced

Valid transitions:

- DISCOVERED -> LIVE, SETTLEMENT_SUBMITTED, CANCELLED, FILLED, INVALID, ORPHANED
- LIVE -> SETTLEMENT_SUBMITTED, CANCELLED, FILLED, INVALID, ORPHANED
- SETTLEMENT_SUBMITTED -> FILLED, CANCELLED, ORPHANED, INVALID
- FILLED -> ORPHANED
- CANCELLED -> ORPHANED
- INVALID -> no transitions
- ORPHANED -> LIVE, CANCELLED, FILLED, INVALID

Practical behavior:

- Duplicate eventId returns IGNORED.
- order-cancelled and trade-confirmed without confirmation evidence return IGNORED.
- Unknown order references in cancellation/settlement/trade events return IGNORED.

## Assumptions Made in Code

1. POC order semantics
- Only SELL side is supported in projection model.
- Capacities, token amounts, indexes, and block numbers are all treated as strings.

2. Event delivery
- Delivery can be at-least-once.
- eventId uniqueness is required for dedupe correctness.
- Out-of-order events can happen and are handled with transition checks and ignore paths.

3. Confirmation model
- Event is considered confirmed if confirmations > 0, or if blockNumber and blockHash are both provided.

4. Reorg model
- Reorg handling currently marks impacted orders ORPHANED by block threshold.
- Trade orphan/reconciliation workflow is not complete yet and should be part of milestone 3 completion and milestone 5 reconciliation.

5. Persistence and audit
- Full raw payload is stored in IngestionEvent payload.
- Processing status is APPLIED, IGNORED, or FAILED.

6. Internal security model
- Internal ingestion uses shared static token from INTERNAL_BOT_TOKEN.
- No per-client key rotation, HMAC signing, or mTLS is implemented yet.

7. Typecheck boundary
- backend/src/bot/index.ts is temporarily excluded from TypeScript compilation to avoid blocking backend milestone work.

## Bot Developer Integration Steps

1. Obtain API configuration
- Base URL for backend
- API_VERSION
- INTERNAL_BOT_TOKEN

2. Implement event sender
- Send POST requests to /api/v{API_VERSION}/internal/events
- Include one accepted auth header
- Send JSON payloads conforming to the event schema

3. Make event IDs stable and unique
- Use deterministic IDs where possible, for example event_type + tx_hash + out_point + block_number
- Do not reuse event IDs across distinct events

4. Always include confirmation data for final-state events
- order-cancelled and trade-confirmed should include confirmations or blockNumber and blockHash

5. Send events in best-effort order, but expect out-of-order tolerance
- Preferred order: order-confirmed -> settlement-submitted -> trade-confirmed
- Backend can ignore invalid transitions and already-seen events

6. Handle backend responses
- status APPLIED: event accepted and projected
- status IGNORED: event recognized but intentionally not applied
- 400: payload schema error
- 401: auth error
- 500: backend processing error

## Open Integration Checklist for Bot Developer

- Confirm exact eventId generation strategy.
- Confirm whether bot sends mempool-only order-discovered events or only block-confirmed order-confirmed events.
- Confirm if chain-reorg events are emitted as individual order impacts or as block-level notifications only.
- Confirm retry strategy on network errors and 500 responses.

## Recommended Next Work

To complete milestone 3 fully:

- Add integration tests for internal ingestion endpoint auth and event outcomes.
- Add service-level tests for transition matrix, duplicate handling, and reorg behavior.
- Ensure event application and ingestion audit writes share the same DB transaction session.
- Add structured logs around ingestion decisions for bot-side debugging.
