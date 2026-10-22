// Checks each bot event's claims against canonical CKB state before it may change the projection.
import { ccc } from "@ckb-ccc/core";
import AppError from "./error.js";
import type { ChainTransaction, ChainVerification } from "./chain-verifier.js";
import type {
  BotEvent,
  ChainReorgEvent,
  OrderCancelledEvent,
  OrderConfirmedEvent,
  SettlementSubmittedEvent,
  TradeConfirmedEvent,
} from "../schemas/bot-events.js";
import type { OrderDocument } from "../models/order.js";
import { decodeDexOrderArgs } from "../utils/dex-order-args.js";
import type { Hex } from "../types/index.js";

type OrderFacts = Pick<OrderDocument, "_id" | "direction" | "ownerLockHash" | "xudtTypeHash" | "pricePerToken" | "remainingAmount">;

export type LoadOrders = (ids: string[]) => Promise<OrderFacts[]>;

const IN_POOL_OR_CHAIN = new Set(["pending", "proposed", "committed"]);

const reject = (reason: string): never => {
  throw new AppError(422, `Event failed chain verification: ${reason}`);
};

const sameHex = (left: string | undefined, right: string | undefined) =>
  left !== undefined && right !== undefined && left.toLowerCase() === right.toLowerCase();

const scriptHash = (script: { codeHash: string; hashType: string; args: string }) =>
  ccc.Script.from(script as ccc.ScriptLike).hash();

const outPointId = (outPoint: { txHash: string; index: string }) => `${outPoint.txHash}:${outPoint.index}`;

function spends(tx: ChainTransaction, outPoint: { txHash: string; index: string }): boolean {
  return tx.inputs.some((input) => sameHex(input.txHash, outPoint.txHash) && BigInt(input.index) === BigInt(outPoint.index));
}

/** A committed transaction in the block the event names, buried at least `confirmationDepth` deep. */
async function requireConfirmed(
  v: ChainVerification,
  txHash: Hex,
  event: { blockNumber?: string; blockHash?: string },
): Promise<ChainTransaction> {
  const tx = await v.chain.getTransaction(txHash);
  if (!tx || tx.status !== "committed" || tx.blockNumber === undefined || !tx.blockHash) {
    return reject(`transaction ${txHash} is not committed`);
  }
  if (!event.blockHash || !sameHex(event.blockHash, tx.blockHash)) {
    return reject("block hash does not match the chain");
  }
  if (event.blockNumber === undefined || BigInt(event.blockNumber) !== tx.blockNumber) {
    return reject("block number does not match the chain");
  }

  const tip = await v.chain.getTip();
  const confirmations = tip >= tx.blockNumber ? tip - tx.blockNumber + 1n : 0n;
  if (confirmations < BigInt(v.confirmationDepth)) {
    throw new AppError(
      409,
      `insufficient-confirmations: ${confirmations} of ${v.confirmationDepth} required`,
    );
  }
  return tx;
}

async function verifyOrderConfirmed(event: OrderConfirmedEvent, v: ChainVerification): Promise<void> {
  const tx = await requireConfirmed(v, event.outPoint.txHash as Hex, event);
  if (event.order.blockNumber !== event.blockNumber) return reject("order block number disagrees with event");
  if (tx.txIndex !== undefined && BigInt(event.order.txIndex) !== tx.txIndex) return reject("tx index does not match the chain");

  const output = tx.outputs[Number(event.outPoint.index)];
  if (!output) return reject("output does not exist");

  if (!sameHex(output.lock.codeHash, v.dexLock.codeHash) || output.lock.hashType !== v.dexLock.hashType) {
    return reject("output is not locked by the configured DEX script");
  }
  if (!sameHex(output.lock.args, event.order.lockScript.args)) return reject("lock args differ from the chain");
  if (!sameHex(output.data, event.order.cellData)) return reject("cell data differs from the chain");
  if (output.capacity !== BigInt(event.order.capacity)) return reject("capacity differs from the chain");

  const decoded = (() => {
    try {
      return decodeDexOrderArgs(output.lock.args);
    } catch (error) {
      return reject(error instanceof Error ? error.message : "undecodable order args");
    }
  })();

  if (decoded.direction !== event.order.direction) return reject("direction differs from lock args");
  if (decoded.pricePerToken !== BigInt(event.order.pricePerToken)) return reject("price differs from lock args");
  if (decoded.tokenAmount !== BigInt(event.order.tokenAmount)) return reject("token amount differs from lock args");
  if (!sameHex(decoded.udtTypeHash, event.order.xudtTypeHash)) return reject("token type differs from lock args");
  if (!sameHex(decoded.makerLockHash, event.order.ownerLockHash)) return reject("maker differs from lock args");
  if (!v.supportedAssetHashes.has(decoded.udtTypeHash)) return reject("token is not a supported manifest asset");

  if (decoded.direction === "ASK") {
    if (!output.type || !sameHex(scriptHash(output.type), decoded.udtTypeHash)) return reject("sell order lacks the declared token type");
    if (!event.order.typeScript || !sameHex(scriptHash(event.order.typeScript), decoded.udtTypeHash)) return reject("event type script differs from the chain");
    const held = ccc.numLeFromBytes(ccc.bytesFrom(output.data).slice(0, 16));
    if (ccc.bytesFrom(output.data).length < 16 || held !== decoded.tokenAmount) return reject("held token amount differs from lock args");
  } else if (output.type) {
    return reject("buy order must not carry a type script");
  }

  // The maker lock never runs at creation, so tie it to the creating transaction's inputs.
  if (!sameHex(scriptHash(event.order.ownerLock), decoded.makerLockHash)) return reject("owner lock does not hash to the maker lock hash");
  if (!tx.inputLockHashes.some((hash) => sameHex(hash, decoded.makerLockHash))) return reject("maker did not fund the order transaction");
}

async function verifyOrderCancelled(event: OrderCancelledEvent, v: ChainVerification, load: LoadOrders): Promise<void> {
  const [order] = await load([outPointId(event.outPoint)]);
  if (!order) return; // ingestion reports order-not-found itself
  const tx = await requireConfirmed(v, event.cancelledByTxHash as Hex, event);
  if (!spends(tx, event.outPoint)) return reject("transaction does not spend the order cell");
  if (!tx.inputLockHashes.some((hash) => sameHex(hash, order.ownerLockHash))) return reject("spend is not authorized by the maker lock");
}

async function verifySettlementSubmitted(event: SettlementSubmittedEvent, v: ChainVerification): Promise<void> {
  const tx = await v.chain.getTransaction(event.settlementTxHash as Hex);
  if (!tx || !IN_POOL_OR_CHAIN.has(tx.status)) return reject("settlement transaction is unknown to the node");
  for (const outPoint of event.orderOutPoints) {
    if (!spends(tx, outPoint)) return reject("settlement does not spend a claimed order");
  }
}

async function verifyTradeConfirmed(event: TradeConfirmedEvent, v: ChainVerification, load: LoadOrders): Promise<void> {
  if (event.trade.confirmedAtBlock !== event.blockNumber) return reject("confirmed block disagrees with event block");
  const ids = [outPointId(event.buyOrderOutPoint), outPointId(event.sellOrderOutPoint)];
  const orders = await load(ids);
  if (orders.length !== 2) return; // ingestion reports order-not-found itself

  const buy = orders.find((order) => order._id === ids[0]);
  const sell = orders.find((order) => order._id === ids[1]);
  if (!buy || !sell || buy.direction !== "BID" || sell.direction !== "ASK") return reject("orders are not a buy/sell pair");

  const tx = await requireConfirmed(v, event.trade.settlementTxHash as Hex, event);
  if (!spends(tx, event.buyOrderOutPoint) || !spends(tx, event.sellOrderOutPoint)) {
    return reject("settlement does not spend both orders");
  }

  const matches =
    sameHex(event.trade.buyerLockHash, buy.ownerLockHash) &&
    sameHex(event.trade.sellerLockHash, sell.ownerLockHash) &&
    sameHex(event.trade.xudtTypeHash, sell.xudtTypeHash) &&
    event.trade.tokenAmount === sell.remainingAmount &&
    event.trade.price === sell.pricePerToken;
  if (!matches) return reject("trade fields differ from the matched orders");
}

async function verifyChainReorg(event: ChainReorgEvent, v: ChainVerification): Promise<void> {
  if (event.ancestorBlockNumber !== undefined && BigInt(event.ancestorBlockNumber) >= BigInt(event.revertedBlockNumber)) {
    return reject("ancestor block must precede the reverted block");
  }
  const canonical = await v.chain.getCanonicalBlockHash(BigInt(event.revertedBlockNumber));
  if (sameHex(canonical, event.revertedBlockHash)) return reject("claimed reverted block is still canonical");
}

export async function verifyEvent(event: BotEvent, v: ChainVerification, load: LoadOrders): Promise<void> {
  switch (event.eventType) {
    case "order-confirmed":
      return verifyOrderConfirmed(event, v);
    case "order-cancelled":
      return verifyOrderCancelled(event, v, load);
    case "settlement-submitted":
      return verifySettlementSubmitted(event, v);
    case "trade-confirmed":
      return verifyTradeConfirmed(event, v, load);
    case "chain-reorg":
      return verifyChainReorg(event, v);
  }
}
