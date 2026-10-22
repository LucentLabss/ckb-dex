// Verifies the faucet's atomic claims, global budgets, testnet-only guard and failure rollback.
import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { ccc } from "@ckb-ccc/core";

import AppConfiguration from "./config.js";
import ClaimStore from "./services/claims.js";
import TokenFaucet from "./services/faucet.js";
import AppError from "./services/error.js";
import Mutex from "./utils/mutex.js";
import FaucetClaim from "./models/claim.js";
import FaucetBudget from "./models/budget.js";
import { createExpressServer } from "./app.js";

let mongod: MongoMemoryServer;
before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("faucet-test"));
  await Promise.all([FaucetClaim.init(), FaucetBudget.init()]);
});
after(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});
beforeEach(async () => {
  await Promise.all([FaucetClaim.deleteMany({}), FaucetBudget.deleteMany({})]);
});

const HOUR = 3_600_000;
const limits = (overrides = {}) => ({
  cooldownMs: 24 * HOUR,
  reservationTimeoutMs: 5 * 60_000,
  dripAmount: 100n,
  dailyMaxClaims: 1_000,
  dailyMaxTokens: 100_000n,
  ...overrides,
});
const lock = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const outcome = (promise: Promise<unknown>) => promise.then(() => "ok", (error: AppError) => error.statusCode);

test("concurrent claims for one recipient: exactly one wins", async () => {
  const store = new ClaimStore(limits());
  const results = await Promise.all(Array.from({ length: 20 }, () => outcome(store.reserve(lock(1), "addr"))));
  assert.equal(results.filter((result) => result === "ok").length, 1);
  assert.ok(results.every((result) => result === "ok" || result === 409 || result === 429));
  assert.equal((await store.usage()).claims, 1, "losers never touch the global budget");
});

test("after a committed claim the cooldown holds, then expires", async () => {
  const store = new ClaimStore(limits());
  const start = new Date("2026-10-22T10:00:00Z");
  const reservation = await store.reserve(lock(1), "addr", start);
  await store.commit(reservation, "0xtx", start);

  await assert.rejects(store.reserve(lock(1), "addr", new Date(start.getTime() + HOUR)), (error: AppError) =>
    error.statusCode === 429 && error.message.includes(`${23 * 3600}s`));
  const again = await store.reserve(lock(1), "addr", new Date(start.getTime() + 24 * HOUR + 1));
  await store.commit(again, "0xtx2", new Date(start.getTime() + 24 * HOUR + 1));
  assert.equal((await FaucetClaim.findById(lock(1)).lean())?.claimCount, 2);
});

test("a claim in cooldown does not consume global budget", async () => {
  const store = new ClaimStore(limits());
  const reservation = await store.reserve(lock(1), "addr");
  await store.commit(reservation, "0xtx");
  for (let i = 0; i < 5; i++) await assert.rejects(store.reserve(lock(1), "addr"));
  assert.equal((await store.usage()).claims, 1);
});

test("releasing a failed claim frees both the recipient and the budget", async () => {
  const store = new ClaimStore(limits());
  const reservation = await store.reserve(lock(1), "addr");
  await store.release(reservation);
  assert.deepEqual(await store.usage(), { claims: 0, tokens: 0n });
  await store.reserve(lock(1), "addr"); // not blocked by the rolled-back attempt
});

test("releasing a retry keeps an earlier completed claim's cooldown", async () => {
  const store = new ClaimStore(limits({ cooldownMs: HOUR }));
  const start = new Date("2026-10-22T10:00:00Z");
  const first = await store.reserve(lock(1), "addr", start);
  await store.commit(first, "0xtx", start);

  const later = new Date(start.getTime() + HOUR + 1);
  const retry = await store.reserve(lock(1), "addr", later);
  await store.release(retry);

  const doc = await FaucetClaim.findById(lock(1)).lean();
  assert.equal(doc?.status, "SENT");
  assert.equal(doc?.lastClaimedAt?.getTime(), start.getTime());
});

test("the daily claim budget is global and exact under concurrency", async () => {
  const store = new ClaimStore(limits({ dailyMaxClaims: 3 }));
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => outcome(store.reserve(lock(i + 1), "addr"))));
  assert.equal(results.filter((result) => result === "ok").length, 3);
  assert.ok(results.every((result) => result === "ok" || result === 503));
  assert.equal((await store.usage()).claims, 3);
  // Recipients refused by the budget are not locked out by their failed attempt.
  assert.equal(await FaucetClaim.countDocuments(), 3);
});

test("the daily token budget caps total issuance", async () => {
  const store = new ClaimStore(limits({ dailyMaxTokens: 250n }));
  const results = await Promise.all(Array.from({ length: 6 }, (_, i) => outcome(store.reserve(lock(i + 1), "addr"))));
  assert.equal(results.filter((result) => result === "ok").length, 2);
  assert.equal((await store.usage()).tokens, 200n);
});

test("a new UTC day starts with a fresh budget", async () => {
  const store = new ClaimStore(limits({ dailyMaxClaims: 1 }));
  const today = new Date("2026-10-22T23:59:00Z");
  await store.reserve(lock(1), "addr", today);
  await assert.rejects(store.reserve(lock(2), "addr", today), (error: AppError) => error.statusCode === 503);
  await store.reserve(lock(2), "addr", new Date("2026-10-23T00:01:00Z"));
});

test("an abandoned reservation can be retaken after the timeout, a fresh one cannot", async () => {
  const store = new ClaimStore(limits());
  const start = new Date("2026-10-22T10:00:00Z");
  await store.reserve(lock(1), "addr", start);
  await assert.rejects(store.reserve(lock(1), "addr", new Date(start.getTime() + 60_000)), (error: AppError) => error.statusCode === 409);
  await store.reserve(lock(1), "addr", new Date(start.getTime() + 6 * 60_000));
});

test("a daily token budget smaller than one drip is refused", () => {
  assert.throws(() => new ClaimStore(limits({ dailyMaxTokens: 50n })), /smaller than a single drip/);
});

// ---- TokenFaucet.claim, with a stubbed chain -------------------------------------------------

const testnetClient = new ccc.ClientPublicTestnet({ url: "http://127.0.0.1:1", fallbacks: [] });
const recipient = (n: number) =>
  ccc.Address.fromScript(
    ccc.Script.from({ codeHash: `0x${"9b".repeat(32)}`, hashType: "type", args: `0x${n.toString(16).padStart(40, "0")}` }),
    testnetClient,
  ).toString();

function stubFaucet(overrides: { dailyMaxClaims?: number; send?: () => Promise<string> } = {}) {
  const faucet = Object.create(TokenFaucet.prototype) as TokenFaucet;
  const sent: string[] = [];
  Object.assign(faucet, {
    config: { dripAmount: 100n, cooldownHours: 24, dailyMaxClaims: overrides.dailyMaxClaims ?? 100, dailyMaxTokens: 10_000n },
    client: testnetClient,
    claims: new ClaimStore(limits({ dailyMaxClaims: overrides.dailyMaxClaims ?? 100 })),
    sendLock: new Mutex(),
    send: overrides.send ?? (async () => { sent.push("tx"); return `0x${sent.length.toString(16).padStart(64, "0")}`; }),
  });
  return { faucet, sent };
}

test("simultaneous claims for one address send exactly one transaction", async () => {
  const { faucet, sent } = stubFaucet();
  const results = await Promise.all(Array.from({ length: 10 }, () => outcome(faucet.claim(recipient(1)))));
  assert.equal(results.filter((result) => result === "ok").length, 1);
  assert.equal(sent.length, 1);
  const { script } = await ccc.Address.fromString(recipient(1), testnetClient);
  assert.equal((await FaucetClaim.findById(script.hash()).lean())?.status, "SENT");
});

test("a failed send rolls the claim back so the recipient can retry", async () => {
  let fail = true;
  const { faucet } = stubFaucet({
    send: async () => { if (fail) throw new Error("issuer out of CKB"); return `0x${"ab".repeat(32)}`; },
  });
  await assert.rejects(faucet.claim(recipient(2)), /issuer out of CKB/);
  assert.equal((await faucet.claims.usage()).claims, 0);

  fail = false;
  assert.equal(await faucet.claim(recipient(2)), `0x${"ab".repeat(32)}`);
});

test("the global budget holds across different recipients", async () => {
  const { faucet, sent } = stubFaucet({ dailyMaxClaims: 2 });
  const results = await Promise.all([1, 2, 3, 4, 5].map((n) => outcome(faucet.claim(recipient(n + 10)))));
  assert.equal(results.filter((result) => result === "ok").length, 2);
  assert.equal(sent.length, 2);
});

test("invalid or oversized addresses are a 400", async () => {
  const { faucet } = stubFaucet();
  for (const bad of ["", "not-an-address", "ckb1qyqwrongnetwork", "x".repeat(300)]) {
    await assert.rejects(faucet.claim(bad), (error: AppError) => error.statusCode === 400, bad.slice(0, 20));
  }
});

// ---- configuration & HTTP ---------------------------------------------------------------------

const withEnv = async (env: Record<string, string | undefined>, fn: () => Promise<void>) => {
  const original = { ...process.env };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try { await fn(); } finally { process.env = original; }
};
// Pin every FAUCET_* input: config loading also reads a developer's local .env.
const baseEnv = {
  MONGO_DB_URL: "mongodb://x", CKB_RPC_URL: "http://x", FAUCET_ISSUER_PRIVATE_KEY: `0x${"11".repeat(32)}`,
  FAUCET_DRIP_AMOUNT: "100", FAUCET_COOLDOWN_HOURS: "24", FAUCET_DAILY_MAX_CLAIMS: undefined, FAUCET_DAILY_MAX_TOKENS: undefined,
};

test("the faucet refuses to run on anything but testnet", async () => {
  for (const network of ["mainnet", "devnet"]) {
    await withEnv({ ...baseEnv, CKB_NETWORK: network }, async () => {
      await assert.rejects(new AppConfiguration().getEnvironment(), /only runs on testnet/, network);
    });
  }
  await withEnv({ ...baseEnv, CKB_NETWORK: "testnet" }, async () => {
    const config = await new AppConfiguration().getEnvironment();
    assert.equal(config.ckbNetwork, "testnet");
    assert.equal(config.dailyMaxClaims, 500);
    assert.equal(config.dailyMaxTokens, 100n * 500n);
  });
});

test("the faucet rejects nonsensical limits", async () => {
  for (const env of [
    { FAUCET_DRIP_AMOUNT: "0" }, { FAUCET_DRIP_AMOUNT: "abc" }, { FAUCET_DAILY_MAX_CLAIMS: "-1" },
    { FAUCET_COOLDOWN_HOURS: "0" }, { FAUCET_DRIP_AMOUNT: "100", FAUCET_DAILY_MAX_TOKENS: "10" },
  ]) {
    await withEnv({ ...baseEnv, CKB_NETWORK: "testnet", ...env }, async () => {
      await assert.rejects(new AppConfiguration().getEnvironment(), /must be|positive/, JSON.stringify(env));
    });
  }
});

test("claim endpoint maps errors and bounds the request body", async () => {
  const { faucet } = stubFaucet({ dailyMaxClaims: 1 });
  const server = createExpressServer(faucet).listen(0);
  const { port } = server.address() as { port: number };
  const post = (body: string) => fetch(`http://127.0.0.1:${port}/api/v1/faucet/claim`, {
    method: "POST", headers: { "content-type": "application/json" }, body,
  });
  try {
    assert.equal((await post(JSON.stringify({ address: "nope" }))).status, 400);
    assert.equal((await post("{broken")).status, 400);
    assert.equal((await post(JSON.stringify({ pad: "x".repeat(10_000) }))).status, 413);
    const health = await (await fetch(`http://127.0.0.1:${port}/api/v1/faucet/health`)).json() as any;
    assert.equal(health.data.dailyMaxClaims, 1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
