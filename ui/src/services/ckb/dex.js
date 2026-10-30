/**
 * Builds dex-order-lock transactions (create / cancel), signed by the
 * connected wallet. Ported from ckb-dex/ui/src/lib/dex.ts.
 *
 * Order args (smart-contract/contracts/dex-order-lock/src/main.rs), 90 bytes:
 *   version(1) + side(1) + makerLockHash(32) + xudtTypeHash(32)
 *   + tokenAmount(u128 LE) + price(u64 LE)
 * `price` is the flat total CKB (shannons) for the whole tokenAmount, not a
 * per-token rate; a buy and a sell match only on identical amount and price.
 * Every builder first checks the RPC is on the manifest's chain (verifyChain).
 */
import { ccc } from "@ckb-ccc/connector-react";
import { MAX_SETTLEMENT_FEE } from "../../../../shared/settlement-capacity.mjs";
import { UserError } from "../../utils/errors.js";
import { dexScript, verifyChain, xudtCellDeps } from "./client.js";

export const ORDER_ARGS_LEN = 90;
export const ORDER_VERSION = 1;
export const SIDE_BUY = 0;
export const SIDE_SELL = 1;
const FEE_RATE = 1_000;

/**
 * Extra CKB on a buy order for the settlement fee. The contract caps that fee
 * at MAX_SETTLEMENT_FEE (10,000 shannons) and returns everything else on the
 * order to the buyer inside their new token cell (validate_buy_order in main.rs),
 * so the headroom isn't lost. Same reserve as the team's ui/src/lib/dex.ts.
 */
export const SETTLEMENT_FEE_RESERVE = 2n * MAX_SETTLEMENT_FEE;

export function buildDexLock({ side, makerLockHash, xudtTypeHash, tokenAmount, price }) {
  const args = ccc.bytesConcat(
    new Uint8Array([ORDER_VERSION, side]),
    ccc.bytesFrom(makerLockHash),
    ccc.bytesFrom(xudtTypeHash),
    ccc.numLeToBytes(tokenAmount, 16),
    ccc.numLeToBytes(price, 8)
  );
  if (args.length !== ORDER_ARGS_LEN) {
    throw new Error(`Expected ${ORDER_ARGS_LEN}-byte order args, got ${args.length}`);
  }
  return ccc.Script.from({ codeHash: dexScript.codeHash, hashType: dexScript.hashType, args: ccc.hexFrom(args) });
}

/** Capacity of the token cell a buyer receives on settlement (its minimum occupied size). */
export function settlementTokenCellCapacity(makerLock, token, tokenAmount) {
  const scratch = ccc.Transaction.from({
    outputs: [{ lock: makerLock, type: token.type }],
    outputsData: [ccc.numLeToBytes(tokenAmount, 16)],
  });
  return scratch.outputs[0].capacity;
}

/**
 * CKB a buy order locks up: the price, the token cell it will receive, and the
 * settlement fee reserve. Whatever the fee doesn't use comes back in the token cell.
 */
export function buyOrderCapacity(makerLock, token, tokenAmount, totalPrice) {
  return totalPrice + settlementTokenCellCapacity(makerLock, token, tokenAmount) + SETTLEMENT_FEE_RESERVE;
}

/**
 * Rough network fee for an order tx before it's built (shannons): about 1 KB
 * at the 1,000 shannons/KB rate used here. Shown as an estimate until the
 * exact fee is known.
 */
export const ESTIMATED_ORDER_FEE = 1_000n;

/** CKB deposit a sell order's cell holds (its minimum occupied size), computed locally. */
export function sellOrderDeposit(makerLock, token, tokenAmount, totalPrice) {
  const dexLock = buildDexLock({
    side: SIDE_SELL,
    makerLockHash: makerLock.hash(),
    xudtTypeHash: token.typeHash,
    tokenAmount,
    price: totalPrice,
  });
  const scratch = ccc.Transaction.from({
    outputs: [{ lock: dexLock, type: token.type }],
    outputsData: [ccc.numLeToBytes(tokenAmount, 16)],
  });
  return scratch.outputs[0].capacity;
}

/** A "plain" cell is what the wallet's CKB balance counts: no type script, no data. */
const isPlain = (output, data) => !output.type && ccc.bytesFrom(data ?? "0x").length === 0;

/**
 * How `tx` changes the wallet's balances as the UI shows them: `ckb` is the
 * change in plain CKB (shannons), `token` the change in token units. CKB that
 * moves into an order cell or a token cell leaves the plain balance even
 * though it still belongs to the user.
 */
export async function walletDelta(tx, client, lock, token) {
  const lockHash = lock.hash();
  const ownsCell = (output) => output.lock.hash() === lockHash;
  const isToken = (output) => token && output.type?.hash() === token.typeHash;
  let ckb = 0n;
  let tokens = 0n;

  for (const input of tx.inputs) {
    const cell = await client.getCell(input.previousOutput);
    if (!cell || !ownsCell(cell.cellOutput)) continue;
    if (isPlain(cell.cellOutput, cell.outputData)) ckb -= cell.cellOutput.capacity;
    else if (isToken(cell.cellOutput)) tokens -= ccc.udtBalanceFrom(cell.outputData);
  }
  tx.outputs.forEach((output, i) => {
    if (!ownsCell(output)) return;
    if (isPlain(output, tx.outputsData[i])) ckb += output.capacity;
    else if (isToken(output)) tokens += ccc.udtBalanceFrom(tx.outputsData[i]);
  });
  return { ckb, token: tokens };
}

export async function buildCreateOrderTx({ signer, client, token, side, tokenAmount, totalPrice }) {
  await verifyChain();
  const { script: makerLock } = await signer.getRecommendedAddressObj();
  const dexLock = buildDexLock({
    side,
    makerLockHash: makerLock.hash(),
    xudtTypeHash: token.typeHash,
    tokenAmount,
    price: totalPrice,
  });

  if (side === SIDE_SELL) {
    // The order cell carries exactly tokenAmount of the token.
    const tx = ccc.Transaction.from({
      outputs: [{ lock: dexLock, type: token.type }],
      outputsData: [ccc.numLeToBytes(tokenAmount, 16)],
    });
    tx.addCellDeps(xudtCellDeps);
    await tx.completeInputsByUdt(signer, token.type);

    const inBalance = await tx.getInputsUdtBalance(client, token.type);
    const outBalance = tx.getOutputsUdtBalance(token.type);
    if (inBalance < outBalance) throw new Error(`Insufficient ${token.symbol} balance for this order`);
    if (inBalance > outBalance) {
      tx.addOutput({ lock: makerLock, type: token.type }, ccc.numLeToBytes(inBalance - outBalance, 16));
    }

    await tx.completeInputsByCapacity(signer);
    await tx.completeFeeBy(signer, FEE_RATE);
    return tx;
  }

  // BUY: a plain CKB cell pre-funded for the payment and the incoming token cell.
  const tx = ccc.Transaction.from({
    outputs: [{ lock: dexLock, capacity: buyOrderCapacity(makerLock, token, tokenAmount, totalPrice) }],
    outputsData: ["0x"],
  });
  await tx.completeInputsByCapacity(signer);
  await tx.completeFeeBy(signer, FEE_RATE);
  return tx;
}

/**
 * Reads one of our own just-placed orders straight from the chain, so it can
 * be cancelled before the backend lists it (the backend waits for several
 * confirmations). Returns the same shape as a backend order document.
 */
export async function readOwnOrderCell({ client, makerLock, txHash, index = 0 }) {
  const outPoint = { txHash, index: String(index) };
  const cell = await client.getCellLive(outPoint, true);
  if (!cell) {
    throw new UserError(
      "Still confirming",
      "Your order isn't on-chain yet (or was already filled or cancelled). Try again in a few seconds.",
      "warning"
    );
  }
  const { lock, type, capacity } = cell.cellOutput;
  const args = ccc.bytesFrom(lock.args);
  const isOurOrder =
    lock.codeHash === dexScript.codeHash &&
    lock.hashType === dexScript.hashType &&
    args.length === ORDER_ARGS_LEN &&
    ccc.hexFrom(args.slice(2, 34)) === makerLock.hash();
  if (!isOurOrder) throw new Error("That cell isn't one of your DEX orders");

  return {
    outPoint,
    direction: args[1] === SIDE_SELL ? "ASK" : "BID",
    capacity: capacity.toString(),
    ownerLock: makerLock,
    typeScript: type ?? undefined,
    cellData: cell.outputData,
  };
}

/**
 * Spends a live order cell back to its maker. The lock has no signature check
 * of its own: it allows the spend when another input carries the maker's lock
 * (program_entry in main.rs), so we make sure one is present. The contract
 * requires the refund to keep the order's type, data and at least its full
 * capacity; the fee comes from that separate maker input (validate_cancellation).
 */
export async function buildCancelOrderTx({ signer, client, order }) {
  await verifyChain();
  const { script: makerLock } = await signer.getRecommendedAddressObj();
  const isSell = order.direction === "ASK";

  const output = { capacity: BigInt(order.capacity), lock: order.ownerLock };
  if (isSell) {
    if (!order.typeScript) throw new Error("Sell order is missing its token type script");
    output.type = order.typeScript;
  }

  const tx = ccc.Transaction.from({
    inputs: [{ previousOutput: order.outPoint }],
    outputs: [output],
    outputsData: [isSell ? order.cellData : "0x"],
  });
  tx.addCellDeps(dexScript.cellDeps);
  if (isSell) tx.addCellDeps(xudtCellDeps);

  const makerLockHash = makerLock.hash();
  let hasMakerInput = false;
  for (const input of tx.inputs) {
    const cell = await client.getCell(input.previousOutput);
    if (cell?.cellOutput.lock.hash() === makerLockHash) hasMakerInput = true;
  }
  if (!hasMakerInput) await tx.completeInputsAddOne(signer);

  await tx.completeInputsByCapacity(signer);
  await tx.completeFeeBy(signer, FEE_RATE);
  return tx;
}
