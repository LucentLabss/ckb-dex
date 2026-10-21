import { ccc } from "@ckb-ccc/core";
import { getDeployment, getAssetType, createDeploymentClient, verifyDeployment } from "../../../shared/deployment.mjs";

export type Hex = `0x${string}`;

export const DEX_NETWORK = (import.meta.env.VITE_DEX_NETWORK as string | undefined) ?? "testnet";
export const deployment = getDeployment(DEX_NETWORK);
const dexDeployment = deployment.dex;
const xudtDeployment = deployment.knownScripts.XUdt;

export function createDexClient(url: string): ccc.Client {
  return createDeploymentClient(ccc, deployment, url);
}

export async function verifyDexClient(client: ccc.Client): Promise<void> {
  await verifyDeployment(ccc, client, deployment);
}

export const dexCellDeps: ccc.CellDepLike[] = dexDeployment.cellDeps.map(({ cellDep }) => cellDep);
export const xudtCellDeps: ccc.CellDepLike[] = xudtDeployment.cellDeps.map(({ cellDep }) => cellDep);

export const dexScript = {
  codeHash: dexDeployment.codeHash as Hex,
  hashType: dexDeployment.hashType as ccc.HashTypeLike,
};

export const xudtType = ccc.Script.from(getAssetType(deployment));
// Reject stale issuer overrides instead of silently pointing at a different market.
const issuerOverride = import.meta.env.VITE_XUDT_ISSUER_LOCK_HASH as string | undefined;
if (issuerOverride && issuerOverride !== ccc.hexFrom(ccc.bytesFrom(xudtType.args).slice(0, 32))) {
  throw new Error("VITE_XUDT_ISSUER_LOCK_HASH conflicts with the deployment manifest");
}

export const xudtTypeHash: Hex | undefined = xudtType?.hash() as Hex | undefined;

export const ORDER_ARGS_LEN = 90;
export const ORDER_VERSION = 1;
export const SIDE_BUY = 0;
export const SIDE_SELL = 1;
export type OrderSide = typeof SIDE_BUY | typeof SIDE_SELL;

// The network fee for a matched settlement can only come from surplus on the buy order's
// own capacity (the seller must be paid in full - see DexOrderBot.executeTrade), so a buy
// order needs to reserve extra beyond price + its token cell. ~5_520n is the bot's actual
// floor; this pads well past it since we can't compute its estimate exactly ahead of time.
export const SETTLEMENT_FEE_RESERVE = 20_000n;

export function buildDexLock(params: {
  side: OrderSide;
  makerLockHash: Hex;
  xudtTypeHash: Hex;
  tokenAmount: bigint;
  price: bigint;
}): ccc.Script {
  const args = ccc.bytesConcat(
    new Uint8Array([ORDER_VERSION]),
    new Uint8Array([params.side]),
    ccc.bytesFrom(params.makerLockHash),
    ccc.bytesFrom(params.xudtTypeHash),
    ccc.numLeToBytes(params.tokenAmount, 16),
    ccc.numLeToBytes(params.price, 8),
  );

  if (args.length !== ORDER_ARGS_LEN) {
    throw new Error(`Expected ${ORDER_ARGS_LEN}-byte DEX order args, got ${args.length}`);
  }

  return ccc.Script.from({
    codeHash: dexScript.codeHash,
    hashType: dexScript.hashType,
    args: ccc.hexFrom(args),
  });
}

/** Builds a transaction that creates a new BUY or SELL order cell for the connected wallet. */
export async function buildCreateOrderTx(params: {
  signer: ccc.Signer;
  client: ccc.Client;
  side: OrderSide;
  tokenAmount: bigint;
  totalPrice: bigint;
}): Promise<ccc.Transaction> {
  if (!xudtType || !xudtTypeHash) {
    throw new Error("No market token configured in the deployment manifest");
  }

  const { signer, client, side, tokenAmount, totalPrice } = params;
  await verifyDexClient(client);
  const makerAddress = await signer.getRecommendedAddressObj();
  const makerLock = makerAddress.script;
  const makerLockHash = makerLock.hash() as Hex;

  const dexLock = buildDexLock({
    side,
    makerLockHash,
    xudtTypeHash,
    tokenAmount,
    price: totalPrice,
  });

  if (side === SIDE_SELL) {
    const tx = ccc.Transaction.from({
      outputs: [{ lock: dexLock, type: xudtType }],
      outputsData: [ccc.numLeToBytes(tokenAmount, 16)],
    });
    tx.addCellDeps(xudtCellDeps);

    await tx.completeInputsByUdt(signer, xudtType);

    const inputTokenBalance = await tx.getInputsUdtBalance(client, xudtType);
    const outputTokenBalance = tx.getOutputsUdtBalance(xudtType);
    if (inputTokenBalance < outputTokenBalance) {
      throw new Error("Insufficient token balance for this sell order");
    }

    const tokenChange = inputTokenBalance - outputTokenBalance;
    if (tokenChange > 0n) {
      tx.addOutput({ lock: makerLock, type: xudtType }, ccc.numLeToBytes(tokenChange, 16));
    }

    await tx.completeInputsByCapacity(signer);
    await tx.completeFeeBy(signer, 1_000);
    return tx;
  }

  // BUY: pre-fund the order with price + the future token cell's minimal capacity, read
  // off a scratch tx (see validate_buy_order in main.rs).
  const settlementScratchTx = ccc.Transaction.from({
    outputs: [{ lock: makerLock, type: xudtType }],
    outputsData: [ccc.numLeToBytes(tokenAmount, 16)],
  });
  const buyerTokenCapacity = settlementScratchTx.outputs[0].capacity;

  const tx = ccc.Transaction.from({
    outputs: [{ lock: dexLock, capacity: totalPrice + buyerTokenCapacity + SETTLEMENT_FEE_RESERVE }],
    outputsData: ["0x"],
  });

  await tx.completeInputsByCapacity(signer);
  await tx.completeFeeBy(signer, 1_000);
  return tx;
}

export interface CancelableOrder {
  outPoint: { txHash: Hex; index: string | number };
  direction: "ASK" | "BID";
  capacity: string;
  ownerLock: { codeHash: Hex; hashType: ccc.HashTypeLike; args: Hex };
  typeScript?: { codeHash: Hex; hashType: ccc.HashTypeLike; args: Hex };
  cellData: Hex;
}

/**
 * Returns the order's full capacity and assets to its maker. A separate maker input
 * authorizes cancellation and funds the fee. The contract checks both authorization
 * and the refund; completeInputsByCapacity alone does not guarantee authorization.
 */
export async function buildCancelOrderTx(params: {
  signer: ccc.Signer;
  client: ccc.Client;
  order: CancelableOrder;
}): Promise<ccc.Transaction> {
  const { signer, client, order } = params;
  await verifyDexClient(client);
  const makerAddress = await signer.getRecommendedAddressObj();
  const makerLockHash = makerAddress.script.hash() as Hex;

  const output: ccc.CellOutputLike = {
    capacity: BigInt(order.capacity),
    lock: order.ownerLock,
  };
  if (order.direction === "ASK") {
    if (!order.typeScript) {
      throw new Error("Sell order is missing its token type script");
    }
    output.type = order.typeScript;
  }

  const tx = ccc.Transaction.from({
    inputs: [{ previousOutput: order.outPoint }],
    outputs: [output],
    outputsData: [order.direction === "ASK" ? order.cellData : "0x"],
  });

  tx.addCellDeps(dexCellDeps);
  if (order.direction === "ASK") {
    tx.addCellDeps(xudtCellDeps);
  }

  await ensureMakerAuthorityInput(tx, signer, client, makerLockHash);

  await tx.completeInputsByCapacity(signer);
  await tx.completeFeeBy(signer, 1_000);
  return tx;
}

async function ensureMakerAuthorityInput(
  tx: ccc.Transaction,
  signer: ccc.Signer,
  client: ccc.Client,
  makerLockHash: Hex,
): Promise<void> {
  for (const input of tx.inputs) {
    const cell = await client.getCell(input.previousOutput);
    if (cell && cell.cellOutput.lock.hash() === makerLockHash) {
      return;
    }
  }

  await tx.completeInputsAddOne(signer);
}
