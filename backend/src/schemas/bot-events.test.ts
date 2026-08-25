// Tests validation of representative bot event payloads and schema failures.
import test from "node:test";
import assert from "node:assert/strict";
import { botEventSchema } from "./bot-events.js";

const baseEvent = {
  schemaVersion: 1 as const,
  eventId: "evt_001",
  occurredAt: "2026-08-24T12:00:00.000Z",
  transactionHash: "0x1111111111111111111111111111111111111111111111111111111111111111",
  blockNumber: "1000",
  blockHash: "0x2222222222222222222222222222222222222222222222222222222222222222",
  confirmations: 3,
};

test("accepts valid order-confirmed event fixture", () => {
  const parsed = botEventSchema.parse({
    ...baseEvent,
    eventType: "order-confirmed",
    outPoint: {
      txHash: "0x3333333333333333333333333333333333333333333333333333333333333333",
      index: "0",
    },
    order: {
      lockScript: {
        codeHash:
        "0x4444444444444444444444444444444444444444444444444444444444444444",
        hashType: "type",
        args: "0xabcd",
      },
      typeScript: {
        codeHash:
        "0x5555555555555555555555555555555555555555555555555555555555555555",
        hashType: "type",
        args: "0x",
      },
      cellData: "0xe8030000000000000000000000000000",
      capacity: "10000000000",
      ownerLock: {
        codeHash:
          "0x7777777777777777777777777777777777777777777777777777777777777777",
        hashType: "type",
        args: "0x",
      },
      ownerLockHash:
        "0x7777777777777777777777777777777777777777777777777777777777777777",
      direction: "ASK",
      pricePerToken: "3000000000",
      xudtTypeHash:
        "0x6666666666666666666666666666666666666666666666666666666666666666",
      tokenAmount: "1000",
      blockNumber: "999",
      txIndex: "0",
    },
  });

  assert.equal(parsed.eventType, "order-confirmed");
});

test("accepts valid trade-confirmed event fixture", () => {
  const parsed = botEventSchema.parse({
    ...baseEvent,
    eventType: "trade-confirmed",
    buyOrderOutPoint: {
      txHash: "0x3333333333333333333333333333333333333333333333333333333333333333",
      index: "0",
    },
    sellOrderOutPoint: {
      txHash: "0x9999999999999999999999999999999999999999999999999999999999999999",
      index: "1",
    },
    trade: {
      settlementTxHash:
        "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      buyerLockHash:
        "0x7777777777777777777777777777777777777777777777777777777777777777",
      sellerLockHash:
        "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      xudtTypeHash:
        "0x6666666666666666666666666666666666666666666666666666666666666666",
      tokenAmount: "1000",
      price: "3000000000",
      paidCapacity: "13000000000",
      confirmedAtBlock: "1000",
    },
  });

  assert.equal(parsed.eventType, "trade-confirmed");
});

test("rejects invalid event type", () => {
  assert.throws(() =>
    botEventSchema.parse({
      ...baseEvent,
      eventType: "TradeConfirmed",
    }),
  );
});

test("rejects missing required nested payload field", () => {
  assert.throws(() =>
    botEventSchema.parse({
      ...baseEvent,
      eventType: "order-cancelled",
      cancelledByTxHash:
        "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    }),
  );
});
