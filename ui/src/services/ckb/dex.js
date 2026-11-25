/**
 * Builds dex-order-lock-v2 transactions (create / cancel), signed by the
 * connected wallet.
 *
 * Order args (smart-contract/contracts/dex-order-lock-v2/src/main.rs), 243 bytes:
 *   version(1) + side(1) + kind(1) + owner(32) + market(32) + nonce(32)
 *   + priceNum(u128 LE) + priceDen(u128 LE) + initialBase(u128 LE)
 *   + remainingBase(u128 LE) + remainingOffer(u128 LE) + feeReserve(u128 LE)
 *   + costBudget(u64 LE) + maxNetworkFee(u64 LE) + maxRefundFee(u64 LE)
 *   + refundAfter(u64 LE) + minFill(u128 LE)
 *
 * Cancellation witness (14 bytes):
 *   version(1) + action(1) + refund_output_index(u32 LE) + refund_fee(u64 LE)
 */
import { ccc } from "@ckb-ccc/connector-react";
import {
  BPS,
  ORDER_ARGS_LEN as ORDER_ARGS_LEN_V2,
  SIDE_BUY,
  SIDE_SELL,
  ceilDiv,
  decodeDexV2Order,
  encodeDexV2Order,
  encodeDexV2RefundWitness,
} from "../../../../shared/dex-v2-codec.mjs";
import { MAX_SETTLEMENT_FEE } from "../../../../shared/settlement-capacity.mjs";
import { UserError } from "../../utils/errors.js";
import { deployment, dexScript, marketHash, marketInfo, verifyChain, xudtCellDeps } from "./client.js";

export const ORDER_ARGS_LEN_V1 = 90;
export const ORDER_ARGS_LEN = ORDER_ARGS_LEN_V2; // 243 bytes
export const ORDER_VERSION_V1 = 1;
export const ORDER_VERSION = 2;
export { SIDE_BUY, SIDE_SELL };
const FEE_RATE = 1_000;

export const DEFAULT_COST_BUDGET = 100n * 100_000_000n; // 100 CKB (funds treasury storage share ~30.5 CKB per match; unspent budget is refunded on fill or cancel)
export const DEFAULT_MAX_NETWORK_FEE = 10_000n;
export const DEFAULT_MAX_REFUND_FEE = 10_000n;

/**
 * Extra CKB on a buy order for the settlement fee reserve.
 */
export const SETTLEMENT_FEE_RESERVE = 2n * MAX_SETTLEMENT_FEE;

export function randomNonce() {
  const bytes = new Uint8Array(32);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 32; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  if (bytes.every((b) => b === 0)) bytes[0] = 1;
  return ccc.hexFrom(bytes);
}

export function buildDexLock({
  side,
  makerLockHash,
  xudtTypeHash,
  tokenAmount,
  price,
  pricePerToken,
  nonce = randomNonce(),
}) {
  const isBuy = side === SIDE_BUY || side === "BUY" || side === 0;
  const unitPrice =
    pricePerToken ?? (tokenAmount > 0n ? BigInt(price) / BigInt(tokenAmount) : BigInt(price));
  const remainingOffer = isBuy ? BigInt(price) : BigInt(tokenAmount);
  const worstRate = BigInt(Math.max(marketInfo?.config?.makerBps ?? 10, marketInfo?.config?.takerBps ?? 20));
  const feeReserve = isBuy ? ceilDiv(remainingOffer * worstRate, BPS) : 0n;
  const lotSize = BigInt(marketInfo?.config?.lotSize ?? 1);

  const orderArgsHex = encodeDexV2Order({
    side: isBuy ? "BUY" : "SELL",
    kind: "LIMIT",
    owner: makerLockHash,
    market: marketHash,
    nonce,
    priceNum: unitPrice,
    priceDen: BigInt(marketInfo?.config?.tickDen ?? 1),
    initialBase: BigInt(tokenAmount),
    remainingBase: BigInt(tokenAmount),
    remainingOffer,
    feeReserve,
    costBudget: DEFAULT_COST_BUDGET,
    maxNetworkFee: DEFAULT_MAX_NETWORK_FEE,
    maxRefundFee: DEFAULT_MAX_REFUND_FEE,
    refundAfter: 0n,
    minFill: lotSize <= BigInt(tokenAmount) ? lotSize : 1n,
  });

  return ccc.Script.from({
    codeHash: dexScript.codeHash,
    hashType: dexScript.hashType,
    args: orderArgsHex,
  });
}

/** Minimum occupied capacity of the buy order cell. */
export function buyOrderCellOccupiedCapacity(makerLock) {
  const dummyDexLock = buildDexLock({
    side: SIDE_BUY,
    makerLockHash: makerLock ? makerLock.hash() : "0x" + "11".repeat(32),
    tokenAmount: 1n,
    price: 1n,
  });
  const scratch = ccc.Transaction.from({
    outputs: [{ lock: dummyDexLock }],
    outputsData: ["0x"],
  });
  return scratch.outputs[0].capacity;
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
 * CKB a buy order locks up:
 * On-chain V2 escrow requires: cap >= occupied + cost_budget + remaining_offer + fee_reserve.
 */
export function buyOrderCapacity(makerLock, token, tokenAmount, totalPrice) {
  const occupied = buyOrderCellOccupiedCapacity(makerLock);
  const worstRate = BigInt(Math.max(marketInfo?.config?.makerBps ?? 10, marketInfo?.config?.takerBps ?? 20));
  const feeReserve = ceilDiv(BigInt(totalPrice) * worstRate, BPS);
  return occupied + DEFAULT_COST_BUDGET + BigInt(totalPrice) + feeReserve;
}

/**
 * Rough network fee for an order tx before it's built (shannons): about 1 KB
 * at the 1,000 shannons/KB rate used here.
 */
export const ESTIMATED_ORDER_FEE = 1_000n;

/**
 * CKB deposit a sell order's cell holds:
 * On-chain V2 escrow requires: cap >= occupied + cost_budget.
 */
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
  return scratch.outputs[0].capacity + DEFAULT_COST_BUDGET;
}

/** A "plain" cell is what the wallet's CKB balance counts: no type script, no data. */
const isPlain = (output, data) => !output.type && ccc.bytesFrom(data ?? "0x").length === 0;

/**
 * How `tx` changes the wallet's balances as the UI shows them: `ckb` is the
 * change in plain CKB (shannons), `token` the change in token units.
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
    const deposit = sellOrderDeposit(makerLock, token, tokenAmount, totalPrice);
    const tx = ccc.Transaction.from({
      outputs: [{ lock: dexLock, type: token.type, capacity: deposit }],
      outputsData: [ccc.numLeToBytes(tokenAmount, 16)],
    });
    tx.addCellDeps(dexScript.cellDeps);
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

  // BUY: a plain CKB cell pre-funded for the payment, cost budget, occupied capacity, and fee reserve.
  const tx = ccc.Transaction.from({
    outputs: [{ lock: dexLock, capacity: buyOrderCapacity(makerLock, token, tokenAmount, totalPrice) }],
    outputsData: ["0x"],
  });
  tx.addCellDeps(dexScript.cellDeps);
  await tx.completeInputsByCapacity(signer);
  await tx.completeFeeBy(signer, FEE_RATE);
  return tx;
}

/**
 * Reads one of our own just-placed orders straight from the chain, so it can
 * be cancelled before the backend lists it.
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

  let direction = "BID";
  let isOurOrder = false;

  if (args.length === ORDER_ARGS_LEN_V2) {
    const v2 = decodeDexV2Order(args);
    isOurOrder =
      lock.codeHash === dexScript.codeHash &&
      lock.hashType === dexScript.hashType &&
      v2.owner.toLowerCase() === makerLock.hash().toLowerCase();
    direction = v2.side === "BUY" ? "BID" : "ASK";
  } else if (args.length === ORDER_ARGS_LEN_V1) {
    isOurOrder =
      (lock.codeHash === dexScript.codeHash || lock.codeHash === deployment.knownScripts?.DexOrderLockV1?.codeHash) &&
      ccc.hexFrom(args.slice(2, 34)).toLowerCase() === makerLock.hash().toLowerCase();
    direction = args[1] === SIDE_SELL ? "ASK" : "BID";
  }

  if (!isOurOrder) throw new Error("That cell isn't one of your DEX orders");

  return {
    outPoint,
    direction,
    capacity: capacity.toString(),
    ownerLock: makerLock,
    typeScript: type ?? undefined,
    cellData: cell.outputData,
    orderVersion: args.length === ORDER_ARGS_LEN_V2 ? 2 : 1,
  };
}

/**
 * Spends a live order cell back to its maker (cancellation).
 */
export async function buildCancelOrderTx({ signer, client, order }) {
  await verifyChain();
  const { script: makerLock } = await signer.getRecommendedAddressObj();
  const isSell = order.direction === "ASK";

  const ownerLock = ccc.Script.from(order.ownerLock ?? makerLock);
  const output = { capacity: BigInt(order.capacity), lock: ownerLock };
  if (isSell) {
    if (!order.typeScript) throw new Error("Sell order is missing its token type script");
    output.type = ccc.Script.from(order.typeScript);
  }

  const tx = ccc.Transaction.from({
    inputs: [{ previousOutput: order.outPoint }],
    outputs: [output],
    outputsData: [isSell ? order.cellData : "0x"],
  });
  tx.addCellDeps(dexScript.cellDeps);
  if (isSell) tx.addCellDeps(xudtCellDeps);

  // Check if order is V2 (args length 243)
  let isV2 = order.orderVersion === 2;
  if (!isV2) {
    const rawArgs = order.lockScript?.args ?? order.dexLockArgs;
    if (rawArgs && ccc.bytesFrom(rawArgs).length === ORDER_ARGS_LEN_V2) {
      isV2 = true;
    } else {
      const liveCell = await client.getCell(order.outPoint);
      if (liveCell && ccc.bytesFrom(liveCell.cellOutput.lock.args).length === ORDER_ARGS_LEN_V2) {
        isV2 = true;
      }
    }
  }

  if (isV2) {
    tx.setWitnessArgs(0, {
      lock: encodeDexV2RefundWitness({
        action: "CANCEL",
        refundOutputIndex: 0,
        refundFee: 0n,
      }),
    });
  }

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
