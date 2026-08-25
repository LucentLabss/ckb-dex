import { ccc } from "@ckb-ccc/core";
import {
  buyerAddress,
  buyerSigner,
  client,
  dexDeployment,
  makerLock,
  xudtDeployment,
  xudtType,
} from "./shared.js";

const orderTxHash = process.env.ORDER_TX_HASH;
if (!orderTxHash) {
  throw new Error("ORDER_TX_HASH is missing from .env");
}

const orderOutputIndex = BigInt(process.env.ORDER_OUTPUT_INDEX ?? "0");
if (orderOutputIndex < 0n) {
  throw new Error("ORDER_OUTPUT_INDEX must not be negative");
}

const orderOutPoint = ccc.OutPoint.from({
  txHash: orderTxHash,
  index: orderOutputIndex,
});

const orderCell = await client.getCellLive(orderOutPoint, true, true);
if (!orderCell) {
  throw new Error("Order Cell does not exist or has already been spent");
}

const orderLock = orderCell.cellOutput.lock;
const orderType = orderCell.cellOutput.type;

if (
  orderLock.codeHash !== dexDeployment.codeHash ||
  orderLock.hashType !== dexDeployment.hashType
) {
  throw new Error("The selected Cell is not protected by this DEX contract");
}

if (!orderType) {
  throw new Error("The selected Order Cell has no type script");
}

if (!orderType.eq(xudtType)) {
  throw new Error("The selected Order Cell does not contain the expected xUDT");
}

const dexArgsBytes = ccc.bytesFrom(orderLock.args);
if (dexArgsBytes.length !== 40) {
  throw new Error(`Expected 40-byte DEX args, got ${dexArgsBytes.length}`);
}

const makerLockHashFromArgs = ccc.hexFrom(dexArgsBytes.slice(0, 32));
if (makerLock.hash() !== makerLockHashFromArgs) {
  throw new Error("The configured maker lock does not match the Order Cell");
}

const askPrice = ccc.numLeFromBytes(dexArgsBytes.slice(32, 40));
const makerPayment = orderCell.cellOutput.capacity + askPrice;
const tokenAmount = ccc.udtBalanceFrom(orderCell.outputData);

console.log("Order OutPoint:", {
  txHash: orderOutPoint.txHash,
  index: orderOutPoint.index.toString(),
});
console.log("Order capacity:", orderCell.cellOutput.capacity.toString());
console.log("Ask price:", askPrice.toString());
console.log("Maker payment:", makerPayment.toString());
console.log("Order token amount:", tokenAmount.toString());

const fillOrderTx = ccc.Transaction.from({
  inputs: [
    {
      previousOutput: orderOutPoint,
    },
  ],
  outputs: [
    {
      capacity: makerPayment,
      lock: makerLock,
    },
    {
      lock: buyerAddress.script,
      type: orderType,
    },
  ],
  outputsData: ["0x", orderCell.outputData],
});

fillOrderTx.addCellDeps(
  dexDeployment.cellDeps.map(({ cellDep }) => cellDep),
  xudtDeployment.cellDeps.map(({ cellDep }) => cellDep),
);

const capacityInputsAdded = await fillOrderTx.completeInputsByCapacity(
  buyerSigner,
);

console.log("Buyer capacity inputs added:", capacityInputsAdded);

const [feeInputsAdded, hasChange] = await fillOrderTx.completeFeeBy(
  buyerSigner,
  1_000,
);

console.log("Additional fee inputs:", feeInputsAdded);
console.log("Buyer change created:", hasChange);
console.log("Fill transaction inputs:", fillOrderTx.inputs.length);
console.log("Fill transaction outputs:", fillOrderTx.outputs.length);

fillOrderTx.outputs.forEach((output, index) => {
  console.log(`Output ${index}:`, {
    capacity: output.capacity.toString(),
    lockHash: output.lock.hash(),
    typeHash: output.type?.hash() ?? "none",
    data: fillOrderTx.outputsData[index],
  });
});

console.log(
  "Final CellDeps:",
  fillOrderTx.cellDeps.map((cellDep) => ({
    txHash: cellDep.outPoint.txHash,
    index: cellDep.outPoint.index.toString(),
    depType: cellDep.depType,
  })),
);

const txHash = await buyerSigner.sendTransaction(fillOrderTx);
console.log("Fill transaction sent:", txHash);

await client.waitTransaction(txHash);
console.log("Fill transaction committed:", txHash);
