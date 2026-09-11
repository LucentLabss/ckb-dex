import { ccc } from "@ckb-ccc/core";
import scriptsJson from "../../deployment/scripts.json" with { type: "json" };
import systemScriptsJson from "../../deployment/system-scripts.json" with { type: "json" };

interface DeploymentScriptEntry {
  codeHash: string;
  hashType: string;
  cellDeps: { cellDep: ccc.CellDepLike }[];
}

// `offckb system-scripts --export-style ccc` shape: nested by network, each script keyed
// by its own snake_case name under a `.script` sub-object.
interface OffckbScriptEntry {
  name: string;
  script: DeploymentScriptEntry;
}

// Maps offckb's snake_case script names to ccc's KnownScript names.
const KNOWN_SCRIPT_NAME_MAP: Record<string, ccc.KnownScript> = {
  secp256k1_blake160_sighash_all: ccc.KnownScript.Secp256k1Blake160,
  secp256k1_blake160_multisig_all: ccc.KnownScript.Secp256k1Multisig,
  dao: ccc.KnownScript.NervosDao,
  sudt: ccc.KnownScript.SUdt,
  xudt: ccc.KnownScript.XUdt,
  omnilock: ccc.KnownScript.OmniLock,
  anyone_can_pay: ccc.KnownScript.AnyoneCanPay,
  nostr_lock: ccc.KnownScript.NostrLock,
  type_id: ccc.KnownScript.TypeId,
};

const rpcUrl = process.env.CKB_RPC_URL;
if (!rpcUrl) {
  throw new Error("CKB_RPC_URL is missing from .env");
}

const makerPrivateKey = process.env.MAKER_PRIVATE_KEY;
if (!makerPrivateKey) {
  throw new Error("MAKER_PRIVATE_KEY is missing from .env");
}

const buyerPrivateKey = process.env.BUYER_PRIVATE_KEY;
if (!buyerPrivateKey) {
  throw new Error("BUYER_PRIVATE_KEY is missing from .env");
}

const network = process.env.CKB_NETWORK ?? "devnet";

const systemScriptsForNetwork = (
  systemScriptsJson as Record<string, Record<string, OffckbScriptEntry> | undefined>
)[network];
if (!systemScriptsForNetwork) {
  throw new Error(`No system-scripts entries for network "${network}" in deployment/system-scripts.json`);
}

const xudtEntry = systemScriptsForNetwork.xudt;
if (!xudtEntry) {
  throw new Error(`No "xudt" system-script entry for network "${network}"`);
}
const xudtDeployment = xudtEntry.script;

const systemScripts: Record<ccc.KnownScript, ccc.ScriptInfoLike | undefined> = (() => {
  const known: Record<string, ccc.ScriptInfoLike> = {};
  for (const [snakeName, entry] of Object.entries(systemScriptsForNetwork)) {
    const knownName = KNOWN_SCRIPT_NAME_MAP[snakeName];
    if (!knownName) continue;
    known[knownName] = {
      codeHash: entry.script.codeHash,
      hashType: entry.script.hashType,
      cellDeps: entry.script.cellDeps,
    };
  }
  return known as unknown as Record<ccc.KnownScript, ccc.ScriptInfoLike | undefined>;
})();

const client = new ccc.ClientPublicTestnet({
  url: rpcUrl,
  scripts: systemScripts,
});

console.log("xUDT code hash:", xudtDeployment.codeHash);
console.log("xUDT hash type:", xudtDeployment.hashType);

const dexDeploymentEntry = (
  scriptsJson as Record<string, Record<string, DeploymentScriptEntry | undefined>>
)[network]?.["dex-order-lock"];
if (!dexDeploymentEntry) {
  throw new Error(`No dex-order-lock deployment found for network "${network}" in deployment/scripts.json`);
}
// Re-bound with a concrete type: the guard above narrows `dexDeploymentEntry` within this
// module, but that narrowing doesn't survive the `export` for other files that import it.
const dexDeployment: DeploymentScriptEntry = dexDeploymentEntry;

console.log("DEX code hash:", dexDeployment.codeHash);
console.log("DEX hash type:", dexDeployment.hashType);

const tip = await client.getTip();

console.log(`${network} tip:`, tip.toString());

const makerSigner = new ccc.SignerCkbPrivateKey(client, makerPrivateKey);
const makerAddress = await makerSigner.getAddressObjSecp256k1();

const makerLock = makerAddress.script;
const makerLockHash = makerLock.hash();

console.log("Maker address:", makerAddress.toString());
console.log("Maker lock hash:", makerLockHash);

const buyerSigner = new ccc.SignerCkbPrivateKey(client, buyerPrivateKey);
const buyerAddress = await buyerSigner.getAddressObjSecp256k1();

console.log("Buyer address:", buyerAddress.toString());

const xudtArgsBytes = ccc.bytesConcat(makerLockHash, new Uint8Array(4));
if (xudtArgsBytes.length !== 36) {
  throw new Error(`Expected 36-byte xUDT args, got ${xudtArgsBytes.length}`);
}
const xudtArgs = ccc.hexFrom(xudtArgsBytes);

console.log("xUDT args length:", xudtArgsBytes.length);
console.log("xUDT args:", xudtArgs);

const xudtType = ccc.Script.from({
  codeHash: xudtDeployment.codeHash,
  hashType: xudtDeployment.hashType,
  args: xudtArgs,
});

console.log("xUDT type hash:", xudtType.hash());

const tokenAmount = 1_000n;
const tokenData = ccc.numLeToBytes(tokenAmount, 16);

console.log("Token amount:", tokenAmount.toString());
console.log("Token data:", ccc.hexFrom(tokenData));

// dex-order-lock args (see smart-contract/contracts/dex-order-lock/src/main.rs):
//   version(1) + side(1) + makerLockHash(32) + xudtTypeHash(32) + tokenAmount(16, LE) + price(8, LE)
const ORDER_VERSION = 1;
const SIDE_SELL = 1;

const askPrice = ccc.fixedPointFrom("500");

const dexArgsBytes = ccc.bytesConcat(
  new Uint8Array([ORDER_VERSION]),
  new Uint8Array([SIDE_SELL]),
  makerLockHash,
  xudtType.hash(),
  ccc.numLeToBytes(tokenAmount, 16),
  ccc.numLeToBytes(askPrice, 8),
);

if (dexArgsBytes.length !== 90) {
  throw new Error(`Expected 90-byte DEX args, got ${dexArgsBytes.length}`);
}

const dexArgs = ccc.hexFrom(dexArgsBytes);

console.log("Ask price in shannons:", askPrice.toString());
console.log("DEX args length:", dexArgsBytes.length);
console.log("DEX args:", dexArgs);

const dexLock = ccc.Script.from({
  codeHash: dexDeployment.codeHash,
  hashType: dexDeployment.hashType,
  args: dexArgs,
});

console.log("DEX lock hash:", dexLock.hash());

export {
  askPrice,
  buyerAddress,
  buyerSigner,
  client,
  dexDeployment,
  dexLock,
  makerLock,
  makerSigner,
  tokenAmount,
  tokenData,
  xudtDeployment,
  xudtType,
};
