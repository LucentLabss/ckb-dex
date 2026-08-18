import { ccc } from "@ckb-ccc/core";
import scripts from "../../deployment/scripts.json" with { type: "json" };
import systemScripts from "../../deployment/system-scripts.json" with { type: "json" };

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

const client = new ccc.ClientPublicTestnet({
  url: rpcUrl,
  scripts: systemScripts as unknown as Record<
    ccc.KnownScript,
    ccc.ScriptInfoLike | undefined
  >,
});

const xudtDeployment = systemScripts.XUdt;

console.log("xUDT code hash:", xudtDeployment.codeHash);
console.log("xUDT hash type:", xudtDeployment.hashType);

const dexDeployment = scripts.devnet["dex-order-lock"];

console.log("DEX code hash:", dexDeployment.codeHash);
console.log("DEX hash type:", dexDeployment.hashType);

const tip = await client.getTip();

console.log("Devnet tip:", tip.toString());

const makerSigner = new ccc.SignerCkbPrivateKey(client, makerPrivateKey);
const makerAddress = await makerSigner.getAddressObjSecp256k1();

const makerLock = makerAddress.script;
const makerLockHash = makerLock.hash();

console.log("Maker address:", makerAddress.toString());
console.log("Maker lock hash:", makerLockHash);

const buyerSigner = new ccc.SignerCkbPrivateKey(client, buyerPrivateKey);
const buyerAddress = await buyerSigner.getAddressObjSecp256k1();

console.log("Buyer address:", buyerAddress.toString());

const askPrice = ccc.fixedPointFrom("500");
const askPriceBytes = ccc.numLeToBytes(askPrice, 8);

console.log("Ask price in shannons:", askPrice.toString());
console.log("Ask price bytes:", ccc.hexFrom(askPriceBytes));

const dexArgsBytes = ccc.bytesConcat(makerLockHash, askPriceBytes);

if (dexArgsBytes.length !== 40) {
  throw new Error(`Expected 40-byte DEX args, got ${dexArgsBytes.length}`);
}

const dexArgs = ccc.hexFrom(dexArgsBytes);

console.log("DEX args length:", dexArgsBytes.length);
console.log("DEX args:", dexArgs);

const dexLock = ccc.Script.from({
  codeHash: dexDeployment.codeHash,
  hashType: dexDeployment.hashType,
  args: dexArgs,
});

console.log("DEX lock hash:", dexLock.hash());

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
