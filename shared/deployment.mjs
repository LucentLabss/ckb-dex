import manifest from "../deployment/manifest.json" with { type: "json" };

const HASH = /^0x[0-9a-fA-F]{64}$/;
const BYTES = /^0x(?:[0-9a-fA-F]{2})*$/;
const HASH_TYPES = ["data", "type", "data1", "data2"];

function validateScript(script, name) {
  if (!script || !HASH.test(script.codeHash) || !HASH_TYPES.includes(script.hashType)
      || !Array.isArray(script.cellDeps)) {
    throw new Error(`Invalid deployment script: ${name}`);
  }
  for (const { cellDep } of script.cellDeps) {
    if (!cellDep || !HASH.test(cellDep.outPoint?.txHash)
        || !Number.isSafeInteger(cellDep.outPoint.index) || cellDep.outPoint.index < 0
        || !["code", "depGroup"].includes(cellDep.depType)) {
      throw new Error(`Invalid cell dependency: ${name}`);
    }
  }
}

export function getDeployment(network) {
  if (manifest.schemaVersion !== 1) throw new Error("Unsupported deployment manifest version");
  const deployment = manifest.deployments[network];
  if (!["devnet", "testnet", "mainnet"].includes(network) || !deployment) {
    throw new Error(`No deployment manifest configured for network "${network}"`);
  }
  if (deployment.network !== network || !HASH.test(deployment.genesisHash)
      || deployment.client !== (network === "mainnet" ? "mainnet" : "testnet")) {
    throw new Error(`Invalid network identity in deployment manifest: ${network}`);
  }
  validateScript(deployment.dex, "dex");
  for (const [name, script] of Object.entries(deployment.knownScripts)) validateScript(script, name);
  if (!deployment.knownScripts.XUdt || !deployment.knownScripts.Secp256k1Blake160
      || !deployment.dex.cellDeps.some(({ cellDep }) => cellDep.depType === "code")
      || !deployment.knownScripts.XUdt.cellDeps.some(({ cellDep }) => cellDep.depType === "code")
      || !deployment.assets?.length) {
    throw new Error("Deployment requires DEX/xUDT dependencies, wallet scripts, and supported assets");
  }
  for (const asset of deployment.assets) {
    if (!asset.id || !BYTES.test(asset.args) || asset.args.length < 66) {
      throw new Error("Invalid supported asset in deployment manifest");
    }
  }
  return deployment;
}

export function getAssetType(deployment, id = "demo") {
  const asset = deployment.assets.find((entry) => entry.id === id);
  if (!asset) throw new Error(`Unsupported asset: ${id}`);
  const { codeHash, hashType } = deployment.knownScripts.XUdt;
  return { codeHash, hashType, args: asset.args };
}

export function assertSupportedAsset(ccc, deployment, type) {
  const hash = ccc.Script.from(type).hash();
  if (!deployment.assets.some((asset) => ccc.Script.from(getAssetType(deployment, asset.id)).hash() === hash)) {
    throw new Error("Token type is not listed in the deployment manifest");
  }
}

export function assertDexConfiguration(deployment, configured) {
  if (configured.codeHash !== deployment.dex.codeHash || configured.hashType !== deployment.dex.hashType
      || configured.args !== "0x") {
    throw new Error("Configured DEX script conflicts with the selected deployment manifest");
  }
}

export function createDeploymentClient(ccc, deployment, url) {
  if (!url) throw new Error("A CKB RPC URL is required");
  const Client = deployment.client === "mainnet" ? ccc.ClientPublicMainnet : ccc.ClientPublicTestnet;
  // Retain CCC's other wallet integrations, but pin every script declared by this deployment.
  const defaults = deployment.network === "devnet" ? {} : new Client({ url, fallbacks: [] }).scripts;
  return new Client({ url, fallbacks: [], scripts: { ...defaults, ...deployment.knownScripts } });
}

export async function verifyDeployment(ccc, client, deployment) {
  const genesis = await client.getHeaderByNumberNoCache(0);
  if (genesis?.hash !== deployment.genesisHash) {
    throw new Error(`RPC genesis does not match the ${deployment.network} deployment manifest`);
  }
  for (const [name, script] of [["DEX", deployment.dex], ["xUDT", deployment.knownScripts.XUdt]]) {
    let matched = false;
    for (const { cellDep } of script.cellDeps) {
      if (cellDep.depType !== "code") continue;
      const cell = await client.getCellLive(cellDep.outPoint, true);
      if (!cell) throw new Error(`${name} dependency is missing or spent`);
      const hash = script.hashType === "type"
        ? cell.cellOutput.type?.hash()
        : ccc.hashCkb(cell.outputData);
      if (hash === script.codeHash) matched = true;
    }
    if (!matched) throw new Error(`${name} dependency does not match its manifest code hash`);
  }
}
