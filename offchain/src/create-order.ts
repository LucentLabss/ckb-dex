import { ccc } from "@ckb-ccc/core";
import {
  client,
  dexLock,
  makerLock,
  makerSigner,
  tokenData,
  xudtDeployment,
  xudtType,
} from "./shared.js";

const createOrderTx = ccc.Transaction.from({
  outputs: [
    {
      lock: dexLock,
      type: xudtType,
    },
  ],
  outputsData: [tokenData],
});

console.log("Create-order transaction outputs:", createOrderTx.outputs.length);
console.log(
  "Order output capacity:",
  createOrderTx.outputs[0].capacity.toString(),
);

createOrderTx.addCellDeps(
  xudtDeployment.cellDeps.map(({ cellDep }) => cellDep),
);

console.log(
  "Create-order transaction CellDeps:",
  createOrderTx.cellDeps.length,
);

const udtInputsAdded = await createOrderTx.completeInputsByUdt(
  makerSigner,
  xudtType,
);

console.log("xUDT inputs added:", udtInputsAdded);

const inputTokenBalance = await createOrderTx.getInputsUdtBalance(
  client,
  xudtType,
);
const outputTokenBalance = createOrderTx.getOutputsUdtBalance(xudtType);

if (inputTokenBalance < outputTokenBalance) {
  throw new Error(
    `Insufficient xUDT balance: inputs=${inputTokenBalance}, outputs=${outputTokenBalance}`,
  );
}

const tokenChange = inputTokenBalance - outputTokenBalance;

if (tokenChange > 0n) {
  createOrderTx.addOutput(
    {
      lock: makerLock,
      type: xudtType,
    },
    ccc.numLeToBytes(tokenChange, 16),
  );
}

const finalOutputTokenBalance =
  createOrderTx.getOutputsUdtBalance(xudtType);

if (inputTokenBalance !== finalOutputTokenBalance) {
  throw new Error(
    `xUDT balance mismatch: inputs=${inputTokenBalance}, outputs=${finalOutputTokenBalance}`,
  );
}

console.log("Order token amount:", outputTokenBalance.toString());
console.log("Maker token change:", tokenChange.toString());

const capacityInputsAdded = await createOrderTx.completeInputsByCapacity(
  makerSigner,
);

console.log("Capacity inputs added:", capacityInputsAdded);
console.log("Create-order transaction inputs:", createOrderTx.inputs.length);

const [feeInputsAdded, hasChange] = await createOrderTx.completeFeeBy(
  makerSigner,
  1_000,
);

console.log("Additional fee inputs:", feeInputsAdded);
console.log("Maker change created:", hasChange);
console.log("Create-order outputs after fee:", createOrderTx.outputs.length);

createOrderTx.outputs.forEach((output, index) => {
  console.log(`Output ${index}:`, {
    capacity: output.capacity.toString(),
    lockHash: output.lock.hash(),
    typeHash: output.type?.hash() ?? "none",
    data: createOrderTx.outputsData[index],
  });
});

console.log(
  "Final CellDeps:",
  createOrderTx.cellDeps.map((cellDep) => ({
    txHash: cellDep.outPoint.txHash,
    index: cellDep.outPoint.index.toString(),
    depType: cellDep.depType,
  })),
);

const txHash = await makerSigner.sendTransaction(createOrderTx);
console.log("Create-order transaction sent:", txHash);

await client.waitTransaction(txHash);
console.log("Create-order transaction committed:", txHash);
