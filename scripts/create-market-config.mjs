#!/usr/bin/env node
import { ccc } from "@ckb-ccc/core";
import { getDeployment, getAssetType, createDeploymentClient } from "../shared/deployment.mjs";
import { encodeDexV2MarketConfig } from "../shared/dex-v2-codec.mjs";
import fs from "node:fs";
import path from "node:path";

const privateKey = process.env.ADMIN_PRIVATE_KEY || process.argv[2];
if (!privateKey) {
  console.error("Usage: node scripts/create-market-config.mjs <ADMIN_PRIVATE_KEY>");
  console.error("Or set ADMIN_PRIVATE_KEY environment variable.");
  process.exit(1);
}

const network = "testnet";
const deployment = getDeployment(network);
const rpcUrl = process.env.CKB_RPC_URL || "https://testnet.ckb.dev";
const client = createDeploymentClient(ccc, deployment, rpcUrl);
const signer = new ccc.SignerCkbPrivateKey(client, privateKey);

const address = await signer.getRecommendedAddress();
console.log("Admin address:", address);
const adminLock = await signer.getRecommendedAddressObj().then((o) => o.script);
const adminLockHash = adminLock.hash();
console.log("Admin lock hash:", adminLockHash);

const balance = await client.getBalance([adminLock]);
console.log("Admin plain CKB balance:", ccc.fixedPointToString(balance), "CKB");

const marketCodeDep = deployment.knownScripts.DexMarketConfig.cellDeps[0].cellDep;
const marketCodeHash = deployment.knownScripts.DexMarketConfig.codeHash;
const marketHashType = deployment.knownScripts.DexMarketConfig.hashType;

const tokenType = ccc.Script.from(getAssetType(deployment, "demo"));
const baseTypeHash = tokenType.hash();
const quoteTypeHash = "0x0000000000000000000000000000000000000000000000000000000000000000";

const marketConfig = {
  admin: adminLockHash,
  treasury: adminLockHash,
  base: baseTypeHash,
  quote: quoteTypeHash,
  makerBps: 10,
  takerBps: 20,
  lotSize: 1n,
  minOrder: 1n,
  maxOrder: 1_000_000_000_000n,
  tickNum: 1n,
  tickDen: 1n,
  status: 0,
};

const marketData = encodeDexV2MarketConfig(marketConfig);

// 1. Collect inputs owned by admin to fund the transaction and anchor the Type ID
const tx = ccc.Transaction.from({});
tx.addCellDeps([{ outPoint: marketCodeDep.outPoint, depType: marketCodeDep.depType }]);

// Add an initial placeholder output so input completion knows how much capacity is needed
const placeholderOutput = {
  lock: adminLock,
  type: {
    codeHash: marketCodeHash,
    hashType: marketHashType,
    args: "0x" + "00".repeat(32),
  },
};
const dummyTx = ccc.Transaction.from({
  outputs: [placeholderOutput],
  outputsData: [marketData],
});
const requiredCapacity = dummyTx.outputs[0].capacity;
console.log("Minimum required capacity for market cell:", ccc.fixedPointToString(requiredCapacity), "CKB");

// Complete inputs for capacity
await tx.completeInputsByCapacity(signer);
if (tx.inputs.length === 0) {
  throw new Error("No live cells available in admin wallet to fund market configuration creation");
}

// 2. Type ID calculation: hash(inputs[0] || 0)
const firstInput = tx.inputs[0];
const inputBytes = firstInput.toBytes();
const outputIndexBytes = ccc.numLeToBytes(0, 8);
const typeId = ccc.hashCkb(ccc.bytesConcat(inputBytes, outputIndexBytes));
console.log("Calculated Type ID:", typeId);

// 3. Set the actual MarketConfig output
const marketScript = {
  codeHash: marketCodeHash,
  hashType: marketHashType,
  args: typeId,
};
const marketScriptObj = ccc.Script.from(marketScript);
const marketHash = marketScriptObj.hash();
console.log("Market configuration type hash:", marketHash);

tx.outputs = [{
  lock: adminLock,
  type: marketScript,
  capacity: requiredCapacity + ccc.fixedPointFrom("5", 8), // small buffer
}];
tx.outputsData = [marketData];

// Complete change and network fee
await tx.completeInputsByCapacity(signer);
await tx.completeFeeBy(signer, 1_000);

console.log("Sending market configuration creation transaction...");
const txHash = await signer.sendTransaction(tx);
console.log("Transaction submitted! Tx Hash:", txHash);
console.log("Waiting for confirmation on CKB testnet...");
await client.waitTransaction(txHash);
console.log("Transaction confirmed on chain!");

const marketEntry = {
  id: "demo-market",
  marketHash,
  typeScript: marketScript,
  cellDep: {
    outPoint: {
      txHash,
      index: 0,
    },
    depType: "code",
  },
  config: marketConfig,
};

console.log("\nMarket configuration cell is live!");
console.log(JSON.stringify(marketEntry, null, 2));

// Update deployment/manifest.json if possible
const manifestPath = path.resolve(import.meta.dirname, "../deployment/manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
manifest.deployments.testnet.market = marketEntry;
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
console.log("Updated deployment/manifest.json with the new market configuration!");
