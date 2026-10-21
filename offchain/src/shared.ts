import { ccc } from "@ckb-ccc/core";
import { getDeployment, getAssetType, createDeploymentClient, verifyDeployment, assertSupportedAsset } from "../../shared/deployment.mjs";

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

const network = process.env.CKB_NETWORK ?? "testnet";
const deployment = getDeployment(network);
const dexDeployment = deployment.dex;
const xudtDeployment = deployment.knownScripts.XUdt;
const client = createDeploymentClient(ccc, deployment, rpcUrl);
await verifyDeployment(ccc, client, deployment);

console.log("xUDT code hash:", xudtDeployment.codeHash);
console.log("DEX code hash:", dexDeployment.codeHash);

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

const xudtType = ccc.Script.from(getAssetType(deployment));
assertSupportedAsset(ccc, deployment, xudtType);

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
