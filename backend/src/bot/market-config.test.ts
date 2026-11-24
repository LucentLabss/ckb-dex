import assert from "node:assert/strict";
import { test } from "node:test";
import { ccc } from "@ckb-ccc/core";
import DexOrderBot from "./index.js";
import { getDeployment } from "../../../shared/deployment.mjs";
import { decodeDexV2MarketConfig, encodeDexV2MarketConfig, type DexV2MarketConfig } from "../utils/dex-v2-codec.js";
import type { Hex } from "../types/index.js";

const market = getDeployment("testnet").market!;
const type = ccc.Script.from(market.typeScript);
const adminLock = ccc.Script.from(market.adminLockScript!);
const treasuryLock = ccc.Script.from(market.treasuryLockScript!);
const config: DexV2MarketConfig = {
  ...market.config,
  lotSize: BigInt(market.config.lotSize),
  minOrder: BigInt(market.config.minOrder),
  maxOrder: BigInt(market.config.maxOrder),
  tickNum: BigInt(market.config.tickNum),
  tickDen: BigInt(market.config.tickDen),
};
const replacementPoint = { txHash: ("0x" + "ab".repeat(32)) as Hex, index: 1 };

function cell(options: {
  config?: Partial<DexV2MarketConfig>;
  type?: ccc.ScriptLike;
  lock?: ccc.ScriptLike;
  outPoint?: ccc.OutPointLike;
  data?: Hex;
} = {}) {
  return ccc.Cell.from({
    outPoint: options.outPoint ?? market.cellDep.outPoint,
    cellOutput: { lock: options.lock ?? adminLock, type: options.type ?? type },
    outputData: options.data ?? encodeDexV2MarketConfig({ ...config, ...options.config }),
  });
}

function setup(overrides: Record<string, unknown> = {}) {
  const reads: ccc.OutPointLike[] = [];
  const client = {
    getCellLive: async (outPoint: ccc.OutPointLike, withData: boolean) => {
      assert.equal(withData, true);
      reads.push(outPoint);
      return cell();
    },
    async *findCellsOnChain(_key: ccc.ClientIndexerSearchKeyLike): AsyncGenerator<ccc.Cell> {
      throw new Error("The live manifest outpoint should not need an indexer query");
    },
    ...overrides,
  };
  const bot = Object.create(DexOrderBot.prototype) as DexOrderBot;
  Object.assign(bot, { config: { ckbNetwork: "testnet" }, client });
  return { bot, reads };
}

test("market lookup reads the live manifest cell and returns the real treasury script", async () => {
  const { bot, reads } = setup();
  const resolved = await bot.resolveMarketConfig(market.marketHash);
  assert.ok(resolved);
  assert.deepEqual(resolved.config, config);
  assert.equal(resolved.treasuryLock.hash(), config.treasury);
  assert.equal(resolved.treasuryLock.args, treasuryLock.args);
  assert.equal(ccc.OutPoint.from(resolved.cellDep.outPoint).txHash, market.cellDep.outPoint.txHash);
  assert.equal(resolved.cellDep.depType, "code");
  assert.deepEqual(reads, [market.cellDep.outPoint]);
});

test("unlisted market hashes fail before any chain lookup", async () => {
  const { bot, reads } = setup();
  assert.equal(await bot.resolveMarketConfig(("0x" + "ee".repeat(32)) as Hex), undefined);
  assert.equal(reads.length, 0);
});

test("a spent config hint is recovered using the exact full type script", async () => {
  const next = cell({ outPoint: replacementPoint, config: { status: 1 } });
  let liveReads = 0;
  let searches = 0;
  const { bot } = setup({
    getCellLive: async (outPoint: ccc.OutPointLike) => {
      liveReads++;
      return ccc.OutPoint.from(outPoint).txHash === market.cellDep.outPoint.txHash ? undefined : next;
    },
    async *findCellsOnChain(key: ccc.ClientIndexerSearchKeyLike) {
      searches++;
      assert.equal(key.scriptType, "type");
      assert.equal(key.scriptSearchMode, "exact");
      assert.equal(key.withData, true);
      assert.equal(ccc.Script.from(key.script).hash(), market.marketHash);
      assert.equal(ccc.Script.from(key.script).codeHash, market.typeScript.codeHash);
      assert.equal(ccc.Script.from(key.script).hashType, "data2");
      assert.equal(ccc.Script.from(key.script).args, market.typeScript.args);
      yield next;
    },
  });
  const resolved = await bot.resolveMarketConfig(market.marketHash);
  assert.ok(resolved);
  assert.equal(resolved.config.status, 1);
  assert.equal(ccc.OutPoint.from(resolved.cellDep.outPoint).txHash, replacementPoint.txHash);
  assert.equal(ccc.OutPoint.from(resolved.cellDep.outPoint).index, 1n);
  assert.equal(liveReads, 2);
  assert.equal(searches, 1);
});

test("market lookup re-reads configuration data instead of retaining a permanent cache", async () => {
  let reads = 0;
  const { bot } = setup({
    getCellLive: async () => cell({ config: { status: reads++ === 0 ? 0 : 1 } }),
  });
  assert.equal((await bot.resolveMarketConfig(market.marketHash))?.config.status, 0);
  assert.equal((await bot.resolveMarketConfig(market.marketHash))?.config.status, 1);
  assert.equal(reads, 2);
});

test("a treasury change is not hidden by previously resolved config data", async () => {
  let reads = 0;
  const { bot } = setup({
    getCellLive: async () => cell({
      config: { treasury: reads++ === 0 ? config.treasury : ("0x" + "ef".repeat(32)) as Hex },
    }),
  });
  assert.ok(await bot.resolveMarketConfig(market.marketHash));
  await assert.rejects(bot.resolveMarketConfig(market.marketHash), /Treasury lock script does not match/);
});

test("wrong full type identity is rejected even when the code hash matches", async () => {
  const { bot } = setup({
    getCellLive: async () => cell({ type: { ...market.typeScript, args: "0x" + "12".repeat(32) } }),
  });
  await assert.rejects(bot.resolveMarketConfig(market.marketHash), /wrong type script/);
});

test("wrong admin lock and malformed onchain config data fail closed", async () => {
  for (const invalid of [
    cell({ lock: { codeHash: adminLock.codeHash, hashType: adminLock.hashType, args: "0x" } }),
    cell({ data: "0x02" }),
  ]) {
    const { bot } = setup({ getCellLive: async () => invalid });
    await assert.rejects(bot.resolveMarketConfig(market.marketHash));
  }
});

test("an indexer result must still be live before it can be used", async () => {
  const { bot } = setup({
    getCellLive: async () => undefined,
    async *findCellsOnChain() { yield cell({ outPoint: replacementPoint }); },
  });
  assert.equal(await bot.resolveMarketConfig(market.marketHash), undefined);
});

test("a mismatched live indexer result is rejected", async () => {
  const { bot } = setup({
    getCellLive: async (outPoint: ccc.OutPointLike) =>
      ccc.OutPoint.from(outPoint).txHash === market.cellDep.outPoint.txHash
        ? undefined : cell({ type: { ...market.typeScript, args: "0x" } }),
    async *findCellsOnChain() { yield cell({ outPoint: replacementPoint }); },
  });
  await assert.rejects(bot.resolveMarketConfig(market.marketHash), /wrong type script/);
});

test("RPC errors propagate instead of being treated as an absent market", async () => {
  const { bot } = setup({
    getCellLive: async () => { throw new Error("RPC unavailable"); },
  });
  await assert.rejects(bot.resolveMarketConfig(market.marketHash), /RPC unavailable/);
});

test("indexer errors propagate when the config hint has been spent", async () => {
  const { bot } = setup({
    getCellLive: async () => undefined,
    async *findCellsOnChain() { throw new Error("Indexer unavailable"); },
  });
  await assert.rejects(bot.resolveMarketConfig(market.marketHash), /Indexer unavailable/);
});

test("the shared config bytes agree with the backend codec", () => {
  assert.deepEqual(decodeDexV2MarketConfig(encodeDexV2MarketConfig(config)), config);
});
