// Tests local configuration defaults and the health/readiness behavior of the Express application.
import test from "node:test";
import assert from "node:assert/strict";

import AppConfiguration, { parseInternalBotToken } from "./config.js";
import { createExpressServer } from "./app.js";
import { getDeployment } from "../../shared/deployment.mjs";

const VALID_TOKEN = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f6";

const withEnvOverrides = async <T>(overrides: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> => {
  const original = { ...process.env };

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return await fn();
  } finally {
    process.env = original;
  }
};

test("AppConfiguration defaults to the manifest's testnet deployment", async () => {
  await withEnvOverrides(
    {
      MONGO_DB_URL: undefined,
      CKB_NETWORK: undefined,
      CKD_DEX_SCRIPT_CODE_HASH: undefined,
      CKB_DEX_SCRIPT_CODE_HASH: undefined,
      CKB_DEX_SCRIPT_HASH_TYPE: undefined,
      CKB_DEX_SCRIPT_ARGS: undefined,
      CKB_RPC_URL: undefined,
      INTERNAL_BOT_TOKEN: VALID_TOKEN,
      PORT: undefined,
      API_VERSION: undefined,
      NODE_ENV: undefined,
    },
    async () => {
      const config = await new AppConfiguration().getEnvironment();

      assert.equal(config.mongodbUrl, "mongodb://127.0.0.1:27017/ckb-dex");
      assert.equal(config.port, 3000);
      assert.equal(config.apiVersion, 1);
      assert.equal(config.enviroment, "development");
      assert.equal(config.internalBotToken, VALID_TOKEN);
      assert.equal(config.ckbNetwork, "testnet");
      assert.equal(config.ckbRpcUrl, "https://testnet.ckb.dev");
      assert.equal(config.dexOrderLockScript.codeHash, getDeployment("testnet").dex.codeHash);
      assert.equal(config.dexOrderLockScript.hashType, getDeployment("testnet").dex.hashType);
      assert.equal(config.dexOrderLockScript.args, "0x");
    },
  );
});

test("AppConfiguration refuses to start without an internal ingestion token", async () => {
  await withEnvOverrides({ INTERNAL_BOT_TOKEN: undefined }, async () => {
    await assert.rejects(new AppConfiguration().getEnvironment(), /INTERNAL_BOT_TOKEN/);
  });
});

test("parseInternalBotToken rejects blank, default, repeated and short tokens", () => {
  for (const bad of [undefined, "", "   ", "dev-internal-bot-token", "dev-token", "a".repeat(40), "short-token"]) {
    assert.throws(() => parseInternalBotToken(bad), /INTERNAL_BOT_TOKEN/, String(bad));
  }
  assert.equal(parseInternalBotToken(VALID_TOKEN), VALID_TOKEN);
});

test("AppConfiguration rejects a legacy DEX override that disagrees with the manifest", async () => {
  await withEnvOverrides({ CKB_NETWORK: "testnet", CKB_DEX_SCRIPT_CODE_HASH: `0x${"11".repeat(32)}` }, async () => {
    await assert.rejects(new AppConfiguration().getEnvironment(), /conflicts/);
  });
});

test("AppConfiguration rejects a network without a deployment", async () => {
  await withEnvOverrides({ CKB_NETWORK: "devnet" }, async () => {
    await assert.rejects(new AppConfiguration().getEnvironment(), /No deployment manifest/);
  });
});

test("Server health and readiness endpoints respond correctly", async () => {
  const app = createExpressServer(
    {
      mongodbUrl: "mongodb://127.0.0.1:27017/ckb-dex",
      ckbRpcUrl: "http://127.0.0.1:8114",
      ckbNetwork: "devnet",
      enviroment: "development",
      dexOrderLockScript: {
        codeHash: `0x${"11".repeat(32)}`,
        hashType: "type",
        args: "0x",
      },
      internalBotToken: VALID_TOKEN,
      port: 3000,
      apiVersion: 1,
    },
    { isReady: () => true },
  );

  const server = app.listen(0);
  const address = server.address();
  assert.ok(address && typeof address === "object" && "port" in address);

  try {
    const healthResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/health`);
    assert.equal(healthResponse.status, 200);

    const readinessResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/readiness`);
    assert.equal(readinessResponse.status, 200);

    const url = `http://127.0.0.1:${address.port}/api/v1/internal/events`;
    const post = (headers: Record<string, string>) =>
      fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: "{}" });
    assert.equal((await post({})).status, 401);
    assert.equal((await post({ authorization: "Bearer wrong" })).status, 401);
    assert.equal((await post({ "x-internal-bot-token": "dev-internal-bot-token" })).status, 401);
    // A valid token passes auth and reaches schema validation.
    assert.equal((await post({ authorization: `Bearer ${VALID_TOKEN}` })).status, 400);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
});
