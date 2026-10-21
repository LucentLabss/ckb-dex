import { ccc } from "@ckb-ccc/core";
import {
  client,
  makerLock,
  makerSigner,
  tokenData,
  xudtDeployment,
  xudtType,
} from "./shared.js";

const expectedIssuer = ccc.hexFrom(ccc.bytesFrom(xudtType.args).slice(0, 32));
if (makerLock.hash() !== expectedIssuer) {
  throw new Error("MAKER_PRIVATE_KEY does not belong to the manifest token issuer");
}

const issueTx = ccc.Transaction.from({
  outputs: [
    {
      lock: makerLock,
      type: xudtType,
    },
  ],
  outputsData: [tokenData],
});

console.log("Issue transaction outputs:", issueTx.outputs.length);
console.log("Issue output capacity:", issueTx.outputs[0].capacity.toString());

issueTx.addCellDeps(xudtDeployment.cellDeps.map(({ cellDep }) => cellDep));

console.log("Issue transaction CellDeps:", issueTx.cellDeps.length);

await issueTx.completeInputsByCapacity(makerSigner);

console.log("Issue transaction inputs:", issueTx.inputs.length);

const [feeInputsAdded, hasChange] = await issueTx.completeFeeBy(
  makerSigner,
  1_000,
);

console.log("Additional fee inputs:", feeInputsAdded);
console.log("Maker change created:", hasChange);
console.log("Issue outputs after fee:", issueTx.outputs.length);

issueTx.outputs.forEach((output, index) => {
  console.log(`Output ${index}:`, {
    capacity: output.capacity.toString(),
    lockHash: output.lock.hash(),
    typeHash: output.type?.hash() ?? "none",
    data: issueTx.outputsData[index],
  });
});

console.log(
  "Final CellDeps:",
  issueTx.cellDeps.map((cellDep) => ({
    txHash: cellDep.outPoint.txHash,
    index: cellDep.outPoint.index.toString(),
    depType: cellDep.depType,
  })),
);

const txHash = await makerSigner.sendTransaction(issueTx);
console.log("Issue transaction sent:", txHash);

await client.waitTransaction(txHash);
console.log("Issue transaction committed:", txHash);
