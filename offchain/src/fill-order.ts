import { ccc } from "@ckb-ccc/core";
import { getDeployment, createDeploymentClient, verifyDeployment, assertSupportedAsset } from "../../shared/deployment.mjs";
import { allocateSettlementCapacity } from "../../shared/settlement-capacity.mjs";

const ORDER_VERSION = 1;
const SIDE_BUY = 0;
const SIDE_SELL = 1;
const ORDER_ARGS_LENGTH = 90;
const FEE_RATE = 1_000n;

interface OrderTerms {
  side: number;
  makerLockHash: string;
  xudtTypeHash: string;
  amount: bigint;
  price: bigint;
}

function readOrderTerms(lock: ccc.Script): OrderTerms {
  const args = ccc.bytesFrom(lock.args);
  if (args.length !== ORDER_ARGS_LENGTH) {
    throw new Error(`Expected ${ORDER_ARGS_LENGTH}-byte DEX args, got ${args.length}`);
  }

  if (args[0] !== ORDER_VERSION) {
    throw new Error(`Unsupported DEX order version: ${args[0]}`);
  }

  const side = args[1];
  if (side !== SIDE_BUY && side !== SIDE_SELL) {
    throw new Error(`Unknown DEX order side: ${side}`);
  }

  return {
    side,
    makerLockHash: ccc.hexFrom(args.slice(2, 34)),
    xudtTypeHash: ccc.hexFrom(args.slice(34, 66)),
    amount: ccc.numLeFromBytes(ccc.hexFrom(args.slice(66, 82))),
    price: ccc.numLeFromBytes(ccc.hexFrom(args.slice(82, 90))),
  };
}

function readOutPoint(prefix: "BUY" | "SELL"): ccc.OutPoint {
  const txHash = process.env[`${prefix}_ORDER_TX_HASH`];
  if (!txHash || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    throw new Error(`${prefix}_ORDER_TX_HASH must be a 32-byte transaction hash`);
  }

  const indexText = process.env[`${prefix}_ORDER_OUTPUT_INDEX`] ?? "0";
  let index: bigint;
  try {
    index = BigInt(indexText);
  } catch {
    throw new Error(`${prefix}_ORDER_OUTPUT_INDEX must be a non-negative integer`);
  }
  if (index < 0n) {
    throw new Error(`${prefix}_ORDER_OUTPUT_INDEX must be a non-negative integer`);
  }

  return ccc.OutPoint.from({ txHash, index });
}

async function findMakerLock(
  outPoint: ccc.OutPoint,
  makerLockHash: string,
): Promise<ccc.Script> {
  const creatingTx = await client.getTransaction(outPoint.txHash);
  if (!creatingTx || creatingTx.status !== "committed") {
    throw new Error(`Could not find the committed order-creation transaction ${outPoint.txHash}`);
  }

  for (const input of creatingTx.transaction.inputs) {
    const previousCell = await client.getCell(input.previousOutput);
    if (previousCell?.cellOutput.lock.hash() === makerLockHash) {
      return previousCell.cellOutput.lock;
    }
  }

  throw new Error(`No creation-transaction input matches maker lock hash ${makerLockHash}`);
}

const network = process.env.CKB_NETWORK ?? "testnet";
const rpcUrl = process.env.CKB_RPC_URL;
if (!rpcUrl) throw new Error("CKB_RPC_URL is missing from .env");
const deployment = getDeployment(network);
const dexDeployment = deployment.dex;
const xudtDeployment = deployment.knownScripts.XUdt;
const client = createDeploymentClient(ccc, deployment, rpcUrl);
await verifyDeployment(ccc, client, deployment);
const buyOutPoint = readOutPoint("BUY");
const sellOutPoint = readOutPoint("SELL");

const [buyCell, sellCell] = await Promise.all([
  client.getCellLive(buyOutPoint, true, true),
  client.getCellLive(sellOutPoint, true, true),
]);
if (!buyCell) throw new Error("Buy Order Cell is missing or already spent");
if (!sellCell) throw new Error("Sell Order Cell is missing or already spent");

for (const cell of [buyCell, sellCell]) {
  if (
    cell.cellOutput.lock.codeHash !== dexDeployment.codeHash ||
    cell.cellOutput.lock.hashType !== dexDeployment.hashType
  ) {
    throw new Error("Both selected cells must use the configured DEX order lock");
  }
}

const buy = readOrderTerms(buyCell.cellOutput.lock);
const sell = readOrderTerms(sellCell.cellOutput.lock);
if (buy.side !== SIDE_BUY || sell.side !== SIDE_SELL) {
  throw new Error("Select one BID (buy) Order Cell and one ASK (sell) Order Cell");
}
if (
  buy.xudtTypeHash !== sell.xudtTypeHash ||
  buy.amount !== sell.amount ||
  buy.price !== sell.price
) {
  throw new Error("The buy and sell orders must have the same xUDT, amount, and total price");
}

if (buyCell.cellOutput.type) {
  throw new Error("A buy Order Cell must not have a type script");
}
const sellType = sellCell.cellOutput.type;
if (sellType) assertSupportedAsset(ccc, deployment, sellType);
if (!sellType || sellType.hash() !== sell.xudtTypeHash) {
  throw new Error("The sell Order Cell type script does not match its declared xUDT hash");
}
if (ccc.udtBalanceFrom(sellCell.outputData) !== sell.amount) {
  throw new Error("The sell Order Cell token amount does not match its declared amount");
}

const [buyerLock, sellerLock] = await Promise.all([
  findMakerLock(buyOutPoint, buy.makerLockHash),
  findMakerLock(sellOutPoint, sell.makerLockHash),
]);

const sellerPayment = sellCell.cellOutput.capacity + sell.price;
if (sellerPayment > 0xffff_ffff_ffff_ffffn) {
  throw new Error("Seller payment exceeds the maximum u64 capacity");
}

const fillOrderTx = ccc.Transaction.from({
  inputs: [
    { previousOutput: buyOutPoint },
    { previousOutput: sellOutPoint },
  ],
  outputs: [
    { capacity: sellerPayment, lock: sellerLock },
    { lock: buyerLock, type: sellType },
  ],
  outputsData: ["0x", sellCell.outputData],
});

fillOrderTx.addCellDeps(
  dexDeployment.cellDeps.map(({ cellDep }) => cellDep),
  xudtDeployment.cellDeps.map(({ cellDep }) => cellDep),
);

const minimumTokenCapacity = fillOrderTx.outputs[1].capacity;
const allocation = allocateSettlementCapacity({
  buyCapacity: buyCell.cellOutput.capacity,
  price: sell.price,
  minimumTokenCapacity,
  fee: fillOrderTx.estimateFee(FEE_RATE),
});
if (!allocation) {
  throw new Error(
    "Buy Order Cell cannot cover the price, buyer token-cell capacity, and network fee",
  );
}

fillOrderTx.outputs[1].capacity = allocation.tokenCapacity;

console.log("Buy Order Cell:", `${buyOutPoint.txHash}:${buyOutPoint.index}`);
console.log("Sell Order Cell:", `${sellOutPoint.txHash}:${sellOutPoint.index}`);
console.log("Matched token amount:", buy.amount.toString());
console.log("Matched total price (shannons):", buy.price.toString());
console.log("Seller receives (shannons):", sellerPayment.toString());
console.log("Buyer token-cell capacity (shannons):", allocation.tokenCapacity.toString());
console.log("Buyer refund inside token cell (shannons):", (allocation.tokenCapacity - minimumTokenCapacity).toString());
console.log("Transaction fee (shannons):", allocation.fee.toString());
console.log("Transaction inputs:", fillOrderTx.inputs.length);
console.log("Transaction outputs:", fillOrderTx.outputs.length);

const txHash = await client.sendTransaction(fillOrderTx);
console.log("Settlement transaction sent:", txHash);
await client.waitTransaction(txHash);
console.log("Settlement transaction committed:", txHash);
