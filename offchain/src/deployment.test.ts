import assert from "node:assert/strict";
import { test } from "node:test";
import { ccc } from "@ckb-ccc/core";
import {
  getDeployment, getAssetType, createDeploymentClient, verifyDeployment,
  assertSupportedAsset, assertDexConfiguration,
} from "../../shared/deployment.mjs";

const deployment = getDeployment("testnet");

test("manifest pins the deployed testnet contract and the demo token", () => {
  assert.equal(deployment.client, "testnet");
  assert.equal(deployment.genesisHash, "0x10639e0895502b5688a6be8cf69460d76541bfa4821629d86d62ba0aae3f9606");
  assert.match(deployment.dex.codeHash, /^0x[0-9a-f]{64}$/);
  assertSupportedAsset(ccc, deployment, getAssetType(deployment));
});

test("unconfigured networks fail instead of borrowing another network's deployment", () => {
  for (const network of ["devnet", "mainnet", "typo", "__proto__"]) {
    assert.throws(() => getDeployment(network), /No deployment manifest/);
  }
});

test("unknown assets and conflicting legacy DEX settings fail", () => {
  assert.throws(() => getAssetType(deployment, "unknown"), /Unsupported asset/);
  assert.throws(() => assertSupportedAsset(ccc, deployment, {
    ...getAssetType(deployment), args: `0x${"11".repeat(36)}`,
  }), /not listed/);
  assertDexConfiguration(deployment, { ...deployment.dex, args: "0x" });
  for (const change of [
    { codeHash: `0x${"11".repeat(32)}` as `0x${string}` },
    { hashType: "type" as const }, { args: "0x01" as const },
  ]) {
    assert.throws(() => assertDexConfiguration(deployment, {
      ...deployment.dex, args: "0x", ...change,
    }), /conflicts/);
  }
});

test("client uses manifest dependencies and preserves CCC wallet integrations", async () => {
  const client = createDeploymentClient(ccc, deployment, "http://127.0.0.1:8114");
  assert.equal(client.addressPrefix, "ckt");
  const xudt = await client.getKnownScript(ccc.KnownScript.XUdt);
  assert.equal(xudt.codeHash, deployment.knownScripts.XUdt.codeHash);
  assert.equal(xudt.cellDeps[0].cellDep.outPoint.txHash,
    deployment.knownScripts.XUdt.cellDeps[0].cellDep.outPoint.txHash);
  assert.ok(await client.getKnownScript(ccc.KnownScript.PWLock));
  assert.throws(() => createDeploymentClient(ccc, deployment, ""), /RPC URL/);
});

function chain(options: { genesis?: string; missing?: boolean; wrongDex?: boolean; wrongXudt?: boolean } = {}) {
  let dependencyReads = 0;
  const client = {
    async getHeaderByNumberNoCache(number: number) {
      assert.equal(number, 0);
      return { hash: options.genesis ?? deployment.genesisHash };
    },
    async getCellLive() {
      dependencyReads++;
      if (options.missing) return undefined;
      return {
        cellOutput: { type: { hash: () => options.wrongXudt
          ? `0x${"00".repeat(32)}` : deployment.knownScripts.XUdt.codeHash } },
        outputData: "0x1234" as const,
      };
    },
  };
  const hashing = { hashCkb: () => options.wrongDex
    ? `0x${"00".repeat(32)}` : deployment.dex.codeHash };
  return { client, hashing, reads: () => dependencyReads };
}

test("valid genesis and matching live DEX/xUDT dependencies pass", async () => {
  const s = chain();
  await verifyDeployment(s.hashing, s.client, deployment);
  assert.equal(s.reads(), 2);
});

test("wrong genesis stops before dependency lookups", async () => {
  const s = chain({ genesis: `0x${"00".repeat(32)}` });
  await assert.rejects(verifyDeployment(s.hashing, s.client, deployment), /genesis/);
  assert.equal(s.reads(), 0);
});

test("missing genesis fails closed", async () => {
  const s = chain();
  await assert.rejects(verifyDeployment(s.hashing, {
    ...s.client, getHeaderByNumberNoCache: async () => undefined,
  }, deployment), /genesis/);
});

test("spent or missing dependency cells fail closed", async () => {
  const s = chain({ missing: true });
  await assert.rejects(verifyDeployment(s.hashing, s.client, deployment), /missing or spent/);
});

test("data-hash and type-hash dependency mismatches fail closed", async () => {
  for (const options of [{ wrongDex: true }, { wrongXudt: true }]) {
    const s = chain(options);
    await assert.rejects(verifyDeployment(s.hashing, s.client, deployment), /does not match/);
  }
});

test("RPC errors propagate instead of enabling a public-network fallback", async () => {
  const s = chain();
  await assert.rejects(verifyDeployment(s.hashing, {
    ...s.client,
    getHeaderByNumberNoCache: async () => { throw new Error("RPC unavailable"); },
  }, deployment), /RPC unavailable/);
});
