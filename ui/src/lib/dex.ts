// Builds and submits dex-order-lock transactions (create / cancel) against the deployed
// DEX contract, using the connected wallet signer instead of a raw private key.
//
// Order args layout (see smart-contract/contracts/dex-order-lock/src/main.rs):
//   version(1) + side(1) + makerLockHash(32) + xudtTypeHash(32) + tokenAmount(16, LE) + price(8, LE) = 90 bytes.
// `price` is the flat total CKB (in shannons) to be exchanged for the whole `tokenAmount`,
// not a per-token rate - matching orders must share the exact same tokenAmount and price.
import { ccc } from "@ckb-ccc/core";
import scriptsJson from "../../../deployment/scripts.json";
import systemScriptsJson from "../../../deployment/system-scripts.json";

export type Hex = `0x${string}`;

interface DeploymentScriptEntry {
  codeHash: string;
  hashType: string;
  cellDeps: { cellDep: ccc.CellDepLike }[];
}

export const DEX_NETWORK = (import.meta.env.VITE_DEX_NETWORK as string | undefined) ?? "devnet";

const dexDeployment = (
  scriptsJson as Record<string, Record<string, DeploymentScriptEntry | undefined>>
)[DEX_NETWORK]?.["dex-order-lock"];

if (!dexDeployment) {
  throw new Error(
    `No dex-order-lock deployment found for network "${DEX_NETWORK}" in deployment/scripts.json`,
  );
}

const xudtDeployment = (systemScriptsJson as Record<string, DeploymentScriptEntry>).XUdt;

export const systemScripts = systemScriptsJson as unknown as Record<
  ccc.KnownScript,
  ccc.ScriptInfoLike | undefined
>;

export const dexCellDeps: ccc.CellDepLike[] = dexDeployment.cellDeps.map(({ cellDep }) => cellDep);
export const xudtCellDeps: ccc.CellDepLike[] = xudtDeployment.cellDeps.map(({ cellDep }) => cellDep);

export const dexScript = {
  codeHash: dexDeployment.codeHash as Hex,
  hashType: dexDeployment.hashType as ccc.HashTypeLike,
};

// The demo token's xUDT args are `issuerLockHash(32) + 0x00000000`, mirroring
// offchain/src/issue-token.ts. Configure the issuer's lock hash so the UI can
// reconstruct the same type script and trade the same token.
const issuerLockHash = import.meta.env.VITE_XUDT_ISSUER_LOCK_HASH as string | undefined;

export const xudtType: ccc.Script | undefined = issuerLockHash
  ? ccc.Script.from({
      codeHash: xudtDeployment.codeHash as Hex,
      hashType: xudtDeployment.hashType as ccc.HashTypeLike,
      args: ccc.hexFrom(ccc.bytesConcat(ccc.bytesFrom(issuerLockHash), new Uint8Array(4))),
    })
  : undefined;

export const xudtTypeHash: Hex | undefined = xudtType?.hash() as Hex | undefined;

export const ORDER_ARGS_LEN = 90;
export const ORDER_VERSION = 1;
export const SIDE_BUY = 0;
export const SIDE_SELL = 1;
export type OrderSide = typeof SIDE_BUY | typeof SIDE_SELL;

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

/**
 * Builds a transaction that creates a new BUY or SELL order cell for the connected wallet.
 * Mirrors offchain/src/create-order.ts, but sized to the real 90-byte contract args and
 * signed by whichever wallet the UI is connected to instead of a private key from .env.
 */
export async function buildCreateOrderTx(params: {
  signer: ccc.Signer;
  client: ccc.Client;
  side: OrderSide;
  tokenAmount: bigint;
  totalPrice: bigint;
}): Promise<ccc.Transaction> {
  if (!xudtType || !xudtTypeHash) {
    throw new Error("No market token configured (set VITE_XUDT_ISSUER_LOCK_HASH)");
  }

  const { signer, client, side, tokenAmount, totalPrice } = params;
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

  // BUY: the order cell must be pre-funded with price + the capacity of the token cell
  // the maker will eventually receive on settlement (see validate_buy_order in main.rs).
  // Build that future output on a scratch transaction purely to read its auto-computed
  // minimal capacity, the same way ccc.Transaction.from sizes any output whose capacity
  // is left unset (see offchain/src/create-order.ts).
  const settlementScratchTx = ccc.Transaction.from({
    outputs: [{ lock: makerLock, type: xudtType }],
    outputsData: [ccc.numLeToBytes(tokenAmount, 16)],
  });
  const buyerTokenCapacity = settlementScratchTx.outputs[0].capacity;

  // The settlement tx the bot builds has exactly two outputs - the seller's payout (which the
  // contract requires be paid in full, no fee deducted) and this buyer's token cell - so the
  // network fee can only come from unclaimed surplus on this order's own capacity. The bot
  // requires that surplus to cover tx.estimateFee(1_000n) (measured ~520 shannons for this
  // exact 2-in/2-out shape) plus its own 5_000n buffer (see DexOrderBot.executeTrade in
  // backend/src/bot/index.ts) - reserve well past that combined ~5_520n floor here too, since
  // this side can't compute the bot's estimate exactly ahead of matching.
  const SETTLEMENT_FEE_RESERVE = 20_000n;

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
 * Builds a transaction that cancels (spends back to the maker) a live order cell.
 * The dex-order-lock has no signature check of its own - it treats the spend as a
 * cancellation once one of the transaction's other inputs carries the maker's own lock
 * hash (see program_entry in main.rs). We guarantee that explicitly rather than relying
 * on completeInputsByCapacity happening to add one, since it may not if the order cell's
 * own capacity already covers the returned output and fee.
 */
export async function buildCancelOrderTx(params: {
  signer: ccc.Signer;
  client: ccc.Client;
  order: CancelableOrder;
}): Promise<ccc.Transaction> {
  const { signer, client, order } = params;
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
