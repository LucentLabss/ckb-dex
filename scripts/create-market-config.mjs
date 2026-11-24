#!/usr/bin/env node
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { getDeployment, getAssetType, createDeploymentClient, verifyDeployment } from "../shared/deployment.mjs";
import { encodeDexV2MarketConfig, decodeDexV2MarketConfig } from "../shared/dex-v2-codec.mjs";

// CCC is installed in offchain/, not at the repository root.
const require = createRequire(new URL("../offchain/package.json", import.meta.url));
const { ccc } = require("@ckb-ccc/core");
const root = fileURLToPath(new URL("../", import.meta.url));
const manifestPath = path.join(root, "deployment/manifest.json");
const receiptPath = path.join(root, "deployment/v2/market-config/testnet/TOKEN-CKB.json");
const json = (value) => JSON.stringify(value, (_, v) => typeof v === "bigint" ? v.toString() : v, 2) + "\n";
const maxFee = 100_000n; // 0.001 CKB, separate from the cell's locked capacity.

function saveManifest(market, originalManifest) {
  if (fs.readFileSync(manifestPath, "utf8") !== originalManifest) {
    throw new Error("Manifest changed during creation. Use the saved receipt to update it; do not create another cell.");
  }
  const manifest = JSON.parse(originalManifest);
  manifest.deployments.testnet.market = market;
  fs.writeFileSync(manifestPath, json(manifest));
}

async function confirmAndSave(client, receipt, originalManifest) {
  const market = receipt.market;
  const confirmed = await client.waitTransaction(market.cellDep.outPoint.txHash, 0, 45_000);
  assert.equal(confirmed?.status, "committed");
  const live = await client.getCellLive(market.cellDep.outPoint, true);
  assert.ok(live, "Configuration output is not live");
  assert.equal(live.cellOutput.type.hash(), market.marketHash);
  assert.equal(ccc.Script.from(market.typeScript).hash(), market.marketHash);
  assert.equal(live.cellOutput.lock.hash(), market.config.admin);
  assert.equal(live.outputData, encodeDexV2MarketConfig(market.config));
  const address = await ccc.Address.fromString(receipt.adminAddress, client);
  assert.equal(address.script.hash(), market.config.admin);
  assert.equal(market.config.treasury, market.config.admin);
  const { codeHash, hashType, args } = live.cellOutput.lock;
  market.adminLockScript = { codeHash, hashType, args };
  market.treasuryLockScript = { codeHash, hashType, args };
  receipt.status = "committed";
  receipt.blockNumber = confirmed.blockNumber.toString();
  receipt.blockHash = confirmed.blockHash;
  receipt.capacityShannons = live.cellOutput.capacity.toString();
  fs.writeFileSync(receiptPath, json(receipt));
  saveManifest(market, originalManifest);
  console.log("Config cell committed and verified. Updated deployment/manifest.json.");
  console.log("Market type hash:", market.marketHash);
  console.log("Outpoint:", market.cellDep.outPoint.txHash + ":0");
}

async function main() {
  const send = process.argv.includes("--send");
  const finalize = process.argv.includes("--finalize");
  if (!finalize && fs.existsSync(receiptPath)) {
    throw new Error("A TOKEN-CKB receipt already exists. Check that transaction before creating another config cell.");
  }

  const originalManifest = fs.readFileSync(manifestPath, "utf8");
  const deployment = getDeployment("testnet");
  const client = createDeploymentClient(ccc, deployment, process.env.CKB_RPC_URL || "https://testnet.ckb.dev");
  await verifyDeployment(ccc, client, deployment);
  const code = deployment.knownScripts.DexMarketConfig;
  assert.equal(code.hashType, "data2");
  const codeDep = code.cellDeps[0].cellDep;
  const codeCell = await client.getCellLive(codeDep.outPoint, true);
  assert.ok(codeCell, "Market configuration code cell is missing or spent");
  assert.equal(ccc.hashCkb(codeCell.outputData), code.codeHash, "Market configuration code hash mismatch");

  if (finalize) {
    const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
    assert.equal(receipt.network, "testnet");
    assert.equal(receipt.market.typeScript.codeHash, code.codeHash);
    assert.equal(receipt.market.typeScript.hashType, code.hashType);
    assert.equal(receipt.market.config.base, ccc.Script.from(getAssetType(deployment, "demo")).hash());
    await confirmAndSave(client, receipt, originalManifest);
    return;
  }

  const privateKey = process.env.ADMIN_PRIVATE_KEY;
  if (!privateKey) throw new Error("Set ADMIN_PRIVATE_KEY locally. Run without --send to check the transaction first.");
  const signer = new ccc.SignerCkbPrivateKey(client, privateKey);
  const adminAddress = await signer.getRecommendedAddressObj();
  if (process.env.EXPECTED_ADMIN_ADDRESS) {
    assert.equal(adminAddress.toString(), process.env.EXPECTED_ADMIN_ADDRESS, "Unexpected admin wallet");
  }
  const adminLock = adminAddress.script;
  const config = {
    ...deployment.market.config,
    admin: adminLock.hash(),
    treasury: adminLock.hash(),
    base: ccc.Script.from(getAssetType(deployment, "demo")).hash(),
    quote: "0x" + "00".repeat(32),
  };
  const data = encodeDexV2MarketConfig(config);
  const checkedConfig = decodeDexV2MarketConfig(data);
  assert.equal(checkedConfig.status, 0, "Expected an active market");
  assert.equal(checkedConfig.makerBps, 10);
  assert.equal(checkedConfig.takerBps, 20);

  // A retry must not silently create a second identity for the same market.
  for await (const cell of client.findCellsOnChain({
    script: { codeHash: code.codeHash, hashType: code.hashType, args: "0x" },
    scriptType: "type",
    scriptSearchMode: "prefix",
    withData: true,
  })) {
    if (cell.cellOutput.lock.hash() === adminLock.hash() && cell.outputData === data) {
      throw new Error("Matching config already exists at " + cell.outPoint.txHash + ":" + cell.outPoint.index + "; reuse it instead.");
    }
  }

  console.log("Network: testnet");
  console.log("Admin and treasury:", adminAddress.toString());
  console.log("Admin lock hash:", adminLock.hash());
  console.log("Maker fee: 0.1%; taker fee: 0.2%");

  // Add the output before collecting capacity. The placeholder has the same
  // occupied size as the real 32-byte Type ID.
  const tx = ccc.Transaction.from({
    cellDeps: [codeDep],
    outputs: [{ lock: adminLock, type: { codeHash: code.codeHash, hashType: code.hashType, args: "0x" + "00".repeat(32) } }],
    outputsData: [data],
  });
  tx.outputs[0].capacity += ccc.fixedPointFrom("5");
  await tx.completeInputsByCapacity(signer);
  assert.ok(tx.inputs.length > 0, "No spendable admin inputs");
  const firstInput = ccc.hexFrom(tx.inputs[0].toBytes());
  const typeId = ccc.hashCkb(ccc.bytesConcat(tx.inputs[0].toBytes(), ccc.numLeToBytes(0, 8)));
  const typeScript = { codeHash: code.codeHash, hashType: code.hashType, args: typeId };
  tx.outputs[0].type = ccc.Script.from(typeScript);
  await tx.completeFeeBy(signer, 1_000);
  const signed = await signer.signTransaction(tx);
  assert.equal(ccc.hexFrom(signed.inputs[0].toBytes()), firstInput, "First input changed after deriving the Type ID");
  assert.equal(signed.outputs[0].type.hash(), ccc.Script.from(typeScript).hash());
  assert.equal(signed.outputs[0].lock.hash(), adminLock.hash());
  assert.equal(signed.outputsData[0], data);
  for (const output of signed.outputs) assert.equal(output.lock.hash(), adminLock.hash(), "Unexpected output recipient");
  const fee = await signed.getFee(client);
  assert.ok(fee > 0n && fee <= maxFee, "Network fee exceeds 0.001 CKB cap");

  console.log("Config cell capacity CKB:", ccc.fixedPointToString(signed.outputs[0].capacity));
  console.log("Network fee shannons:", fee.toString());
  console.log("Transaction hash:", signed.hash());
  const cycles = await client.sendTransactionDry(signed);
  console.log("Testnet transaction check passed; cycles:", cycles.toString());
  if (!send) {
    console.log("Dry run only. Add --send to broadcast and save the config details.");
    return;
  }

  const market = {
    id: deployment.market.id,
    marketHash: ccc.Script.from(typeScript).hash(),
    typeScript,
    cellDep: { outPoint: { txHash: signed.hash(), index: 0 }, depType: "code" },
    config: checkedConfig,
  };
  // Save the public transaction identity before broadcast so an interrupted
  // confirmation wait can be recovered without making another config cell.
  const receipt = { network: "testnet", status: "prepared", adminAddress: adminAddress.toString(), market };
  fs.writeFileSync(receiptPath, json(receipt), { flag: "wx" });
  const hash = await client.sendTransaction(signed);
  assert.equal(hash, market.cellDep.outPoint.txHash);
  receipt.status = "submitted";
  fs.writeFileSync(receiptPath, json(receipt));
  console.log("Submitted:", hash);
  await confirmAndSave(client, receipt, originalManifest);
}

main().catch((error) => {
  console.error(error.message);
  if (fs.existsSync(receiptPath)) console.error("Check the saved transaction with --finalize; do not create another cell.");
  process.exitCode = 1;
});
