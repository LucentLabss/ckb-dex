// Indexes DEX order cells, matches compatible bid/ask pairs, and submits settlement transactions.
import { ccc } from "@ckb-ccc/core";
import type { HydratedDocumentFromSchema } from "mongoose";
import Order, { OrderSchema } from "../models/order.js";
import { Config, Hex, Script } from "../types";
import type { BotEvent } from "../schemas/bot-events.js";
import AppError from "../services/error.js";
import { EventIngestionService } from "../services/event-ingestion.js";
import { toBuffer, toHex } from "../utils/index.js";
import dexScriptsJson from "../../../deployment/scripts.json" with { type: "json" };
import systemScriptsJson from "../../../deployment/system-scripts.json" with { type: "json" };

export type OrderDoc = HydratedDocumentFromSchema<typeof OrderSchema>;

/**
 * dex-order-lock args (see smart-contract/contracts/dex-order-lock/src/main.rs):
 *   version(1) + side(1) + makerLockHash(32) + xudtTypeHash(32) + tokenAmount(16, LE) + price(8, LE)
 * The owner lock isn't embedded on-chain - it's recovered from the creating tx's inputs
 * (see findInputWithLockHash), since the lock script never runs at cell creation.
 */
const ORDER_VERSION = 1;
const SIDE_BUY = 0;
const SIDE_SELL = 1;

const HASH_LEN = 32;
const AMOUNT_LEN = 16;
const PRICE_LEN = 8;
const ORDER_ARGS_LEN = 1 + 1 + HASH_LEN + HASH_LEN + AMOUNT_LEN + PRICE_LEN;

export interface DecodedDexOrderArgs {
  makerLockHash: Hex;
  direction: "ASK" | "BID";
  udtTypeHash: Hex;
  tokenAmount: bigint;
  pricePerToken: bigint;
}

function decodeDexOrderArgs(args: Hex): DecodedDexOrderArgs {
  const buf = toBuffer(args);
  if (buf.length !== ORDER_ARGS_LEN) {
    throw new AppError(
      400,
      `dex order args must be ${ORDER_ARGS_LEN} bytes, got ${buf.length}`,
    );
  }

  const version = buf.readUInt8(0);
  if (version !== ORDER_VERSION) {
    throw new AppError(400, `unsupported dex order args version ${version}`);
  }

  const side = buf.readUInt8(1);
  if (side !== SIDE_BUY && side !== SIDE_SELL) {
    throw new AppError(400, `unknown order side byte ${side}`);
  }

  let offset = 2;
  const makerLockHash = toHex(buf.subarray(offset, offset + HASH_LEN));
  offset += HASH_LEN;
  const udtTypeHash = toHex(buf.subarray(offset, offset + HASH_LEN));
  offset += HASH_LEN;
  const tokenAmount = ccc.numLeFromBytes(toHex(buf.subarray(offset, offset + AMOUNT_LEN)));
  offset += AMOUNT_LEN;
  const pricePerToken = buf.readBigUInt64LE(offset);

  return {
    makerLockHash,
    direction: side === SIDE_SELL ? "ASK" : "BID",
    udtTypeHash,
    tokenAmount,
    pricePerToken,
  };
}

interface DeploymentScriptEntry {
  codeHash: string;
  hashType: string;
  cellDeps: { cellDep: ccc.CellDepLike }[];
}

/** Finds the deployment record (any network bucket) whose script matches the configured DEX lock. */
function resolveDexCellDeps(dexOrderLockScript: Script): ccc.CellDepLike[] {
  const networks = Object.values(
    dexScriptsJson as Record<string, Record<string, DeploymentScriptEntry | undefined>>,
  );

  for (const network of networks) {
    const entry = network["dex-order-lock"];
    if (
      entry &&
      entry.codeHash === dexOrderLockScript.codeHash &&
      entry.hashType === dexOrderLockScript.hashType
    ) {
      return entry.cellDeps.map(({ cellDep }) => cellDep);
    }
  }

  throw new AppError(
    500,
    "No deployment cell deps found for the configured DEX order lock script",
  );
}

// `offckb system-scripts --export-style ccc` shape: nested by network, each script keyed
// by its own snake_case name under a `.script` sub-object.
interface OffckbScriptEntry {
  name: string;
  script: DeploymentScriptEntry;
}

// Maps offckb's snake_case script names to ccc's KnownScript names.
const KNOWN_SCRIPT_NAME_MAP: Record<string, ccc.KnownScript> = {
  secp256k1_blake160_sighash_all: ccc.KnownScript.Secp256k1Blake160,
  secp256k1_blake160_multisig_all: ccc.KnownScript.Secp256k1Multisig,
  dao: ccc.KnownScript.NervosDao,
  sudt: ccc.KnownScript.SUdt,
  xudt: ccc.KnownScript.XUdt,
  omnilock: ccc.KnownScript.OmniLock,
  anyone_can_pay: ccc.KnownScript.AnyoneCanPay,
  nostr_lock: ccc.KnownScript.NostrLock,
  type_id: ccc.KnownScript.TypeId,
};

/** Reads deployment/system-scripts.json's bucket for `network`, translated for ccc's client. */
function resolveNetworkScripts(network: string): {
  known: Record<string, ccc.ScriptInfoLike>;
  raw: Record<string, OffckbScriptEntry>;
} {
  const raw = (systemScriptsJson as Record<string, Record<string, OffckbScriptEntry> | undefined>)[
    network
  ];
  if (!raw) {
    throw new AppError(500, `No system-scripts entries for network "${network}"`);
  }

  const known: Record<string, ccc.ScriptInfoLike> = {};
  for (const [snakeName, entry] of Object.entries(raw)) {
    const knownName = KNOWN_SCRIPT_NAME_MAP[snakeName];
    if (!knownName) continue;
    known[knownName] = {
      codeHash: entry.script.codeHash,
      hashType: entry.script.hashType,
      cellDeps: entry.script.cellDeps,
    };
  }
  return { known, raw };
}

function resolveXudtCellDeps(raw: Record<string, OffckbScriptEntry>, network: string): ccc.CellDepLike[] {
  const xudt = raw.xudt;
  if (!xudt) {
    throw new AppError(500, `No "xudt" system-script entry for network "${network}"`);
  }
  return xudt.script.cellDeps.map(({ cellDep }) => cellDep);
}

interface DexOrderBotTrait {
  readonly config: Config;
  readonly pollInterval: number;
  readonly pendingPairOrders: OrderDoc[];

  sort(orders: OrderDoc[]): OrderDoc[];
  deserializeLockScriptAndArgs(script: Script): DecodedDexOrderArgs;
  scanForPendingOrders(): Promise<OrderDoc[]>;
  checkOrderLiveness(order: OrderDoc): Promise<boolean>;
  markAsResolved(
    orderId: string,
    status: "FILLED" | "CANCELED",
    txHash?: Hex,
  ): Promise<void>;
  executeTrade(buyOrder: OrderDoc, sellOrder: OrderDoc): Promise<Hex>;
  retryFailSwaps(): Promise<void>;
}

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const RESERVATION_TTL_MS = 5 * 60 * 1_000;
// Matches the fixed fee rate the UI uses for its own order transactions (see ui/src/lib/dex.ts).
const SETTLEMENT_FEE_RATE = 1_000n;

export default class DexOrderBot implements DexOrderBotTrait {
  readonly config: Config;
  readonly pollInterval: number;

  private readonly client: ccc.Client;
  private readonly dexCellDeps: ccc.CellDepLike[];
  private readonly xudtCellDeps: ccc.CellDepLike[];
  private readonly ingestionService = new EventIngestionService();

  private _pendingPairOrders: OrderDoc[] = [];
  private lastScannedBlock: bigint | undefined;
  private pollTimer: ReturnType<typeof setInterval> | undefined;

  constructor(config: Config, pollInterval: number = DEFAULT_POLL_INTERVAL_MS) {
    this.config = config;
    this.pollInterval = pollInterval;

    const { known, raw } = resolveNetworkScripts(config.ckbNetwork);

    this.client = new ccc.ClientPublicTestnet({
      url: config.ckbRpcUrl,
      scripts: known as unknown as Record<ccc.KnownScript, ccc.ScriptInfoLike | undefined>,
      // Without this, ClientPublicTestnet falls back to public testnet.ckb.dev/ckbapp.dev
      // on any RPC hiccup instead of failing fast.
      fallbacks: [],
    });

    this.dexCellDeps = resolveDexCellDeps(config.dexOrderLockScript);
    this.xudtCellDeps = resolveXudtCellDeps(raw, config.ckbNetwork);
  }

  get pendingPairOrders(): OrderDoc[] {
    return this._pendingPairOrders;
  }

  /** Starts the poll loop: scan -> reconcile liveness -> sweep stale reservations -> refresh book -> match. */
  start(): void {
    if (this.pollTimer) return;

    const tick = async () => {
      try {
        await this.scanForPendingOrders();
        await this.sweepTrackedOrders();
        await this.retryFailSwaps();
        await this.refreshPendingPairOrders();
        await this.matchPendingOrders();
      } catch (err) {
        console.error("DexOrderBot poll cycle failed:", err);
      }
    };

    void tick();
    this.pollTimer = setInterval(tick, this.pollInterval);
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  /** Price-time priority: best ASK (lowest price) / best BID (highest price) first, ties broken by chain order. */
  sort(orders: OrderDoc[]): OrderDoc[] {
    return [...orders].sort((a, b) => {
      if (a.direction !== b.direction) {
        return a.direction === "ASK" ? -1 : 1;
      }

      const priceA = BigInt(a.pricePerToken.toString());
      const priceB = BigInt(b.pricePerToken.toString());
      const priceDelta = a.direction === "ASK" ? priceA - priceB : priceB - priceA;
      if (priceDelta !== 0n) return priceDelta < 0n ? -1 : 1;

      if (a.blockNumber !== b.blockNumber) {
        return BigInt(a.blockNumber) < BigInt(b.blockNumber) ? -1 : 1;
      }
      if (a.txIndex !== b.txIndex) {
        return BigInt(a.txIndex) < BigInt(b.txIndex) ? -1 : 1;
      }
      return 0;
    });
  }

  deserializeLockScriptAndArgs(script: Script): DecodedDexOrderArgs {
    if (
      script.codeHash !== this.config.dexOrderLockScript.codeHash ||
      script.hashType !== this.config.dexOrderLockScript.hashType
    ) {
      throw new AppError(400, "script is not the configured DEX order lock script");
    }
    return decodeDexOrderArgs(script.args);
  }

  /**
   * Scans on-chain for new DEX order cells since the last scanned block, verifies each
   * one's claimed maker against the transaction that funded it, and indexes it in Mongo.
   */
  async scanForPendingOrders(): Promise<OrderDoc[]> {
    const tip = await this.client.getTip();
    const fromBlock = await this.resolveScanCursor();
    if (fromBlock > tip) return [];

    const dexLockTemplate: Script = {
      codeHash: this.config.dexOrderLockScript.codeHash,
      hashType: this.config.dexOrderLockScript.hashType,
      args: "0x",
    };

    const discovered: OrderDoc[] = [];

    // `findCells`'s public type omits `blockRange`, though it's forwarded to the indexer -
    // type via the wider key so it isn't flagged as an excess property on the literal.
    const searchKey: ccc.ClientIndexerSearchKeyLike = {
      script: dexLockTemplate,
      scriptType: "lock",
      scriptSearchMode: "prefix",
      filter: { blockRange: [fromBlock, tip + 1n] },
      withData: true,
    };

    for await (const cell of this.client.findCells(searchKey, "asc")) {
      const order = await this.indexOrderCell(cell);
      if (order) discovered.push(order);
    }

    this.lastScannedBlock = tip;
    return discovered;
  }

  /** True if the order's cell is still unspent on-chain; reconciles DB state otherwise. */
  async checkOrderLiveness(order: OrderDoc): Promise<boolean> {
    const live = await this.client.getCellLive(order.outPoint!, false);
    if (live) return true;

    await this.reconcileSpentOrder(order);
    return false;
  }

  async markAsResolved(
    orderId: string,
    status: "FILLED" | "CANCELED",
    txHash?: Hex,
  ): Promise<void> {
    await Order.updateOne(
      { _id: orderId },
      {
        $set: {
          status,
          reservedUntil: null,
          pendingTxHash: txHash ?? null,
        },
      },
    );
  }

  /**
   * Builds and submits the settlement tx crossing one BUY against one matching SELL order.
   * No signer needed - the lock script has no signature check, only structural rules.
   */
  async executeTrade(buyOrder: OrderDoc, sellOrder: OrderDoc): Promise<Hex> {
    if (buyOrder.direction !== "BID" || sellOrder.direction !== "ASK") {
      throw new AppError(400, "executeTrade requires a BID (buy) order and an ASK (sell) order");
    }
    if (
      buyOrder.xudtTypeHash !== sellOrder.xudtTypeHash ||
      buyOrder.remainingAmount !== sellOrder.remainingAmount ||
      buyOrder.pricePerToken.toString() !== sellOrder.pricePerToken.toString()
    ) {
      throw new AppError(400, "buy and sell orders do not share the same token, amount and price");
    }

    const sellCapacity = BigInt(sellOrder.capacity);
    const price = BigInt(sellOrder.pricePerToken.toString());

    const tx = ccc.Transaction.from({
      inputs: [
        {
          previousOutput: {
            txHash: buyOrder.outPoint!.txHash,
            index: buyOrder.outPoint!.index,
          },
          since: 0,
        },
        {
          previousOutput: {
            txHash: sellOrder.outPoint!.txHash,
            index: sellOrder.outPoint!.index,
          },
          since: 0,
        },
      ],
      outputs: [
        { capacity: sellCapacity + price, lock: sellOrder.ownerLock },
        { lock: buyOrder.ownerLock, type: sellOrder.typeScript },
      ],
      outputsData: ["0x", sellOrder.cellData as Hex],
    });

    // The seller must be paid capacity + price exactly (validate_sell_order rejects less),
    // so the fee can only come from surplus on the buy order's own capacity.
    const buyerTokenCapacity = tx.outputs[1].capacity;
    const fee = tx.estimateFee(SETTLEMENT_FEE_RATE) + 5_000n;
    const buyCapacity = BigInt(buyOrder.capacity);
    if (buyCapacity < price + buyerTokenCapacity + fee) {
      throw new AppError(
        409,
        `buy order ${buyOrder._id} does not carry enough capacity to cover price + its token cell + the network fee`,
      );
    }

    const reservedBuy = await this.reserve(buyOrder._id!);
    if (!reservedBuy) {
      throw new AppError(409, `buy order ${buyOrder._id} is no longer LIVE`);
    }

    const reservedSell = await this.reserve(sellOrder._id!);
    if (!reservedSell) {
      await this.revertToLive(reservedBuy._id!);
      throw new AppError(409, `sell order ${sellOrder._id} is no longer LIVE`);
    }

    try {
      const [buyStillLive, sellStillLive] = await Promise.all([
        this.checkOrderLiveness(reservedBuy),
        this.checkOrderLiveness(reservedSell),
      ]);
      if (!buyStillLive || !sellStillLive) {
        throw new AppError(409, "one of the matched orders was already settled on-chain");
      }

      tx.addCellDeps(this.dexCellDeps);
      tx.addCellDeps(this.xudtCellDeps);

      const txHash = await this.client.sendTransaction(tx);

      await this.ingestionService.ingest({
        schemaVersion: 1,
        eventId: `settlement-submitted:${txHash}`,
        occurredAt: new Date().toISOString(),
        eventType: "settlement-submitted",
        orderOutPoints: [
          { txHash: reservedBuy.outPoint!.txHash as Hex, index: reservedBuy.outPoint!.index.toString() },
          { txHash: reservedSell.outPoint!.txHash as Hex, index: reservedSell.outPoint!.index.toString() },
        ],
        settlementTxHash: txHash,
      } as BotEvent);

      return txHash;
    } catch (err) {
      await Promise.all([
        this.revertToLive(reservedBuy._id!),
        this.revertToLive(reservedSell._id!),
      ]);
      throw err;
    }
  }

  /**
   * Finds the first exact-match pair (same udtTypeHash + tokenAmount + price, one BUY and
   * one SELL) among `orders`, preferring the oldest order on each side within a match.
   */
  findMatch(orders: OrderDoc[]): { buy: OrderDoc; sell: OrderDoc } | undefined {
    const groups = new Map<string, { buys: OrderDoc[]; sells: OrderDoc[] }>();

    for (const order of this.sort(orders)) {
      const key = this.matchGroupKey(order);
      const bucket = groups.get(key) ?? { buys: [], sells: [] };
      (order.direction === "BID" ? bucket.buys : bucket.sells).push(order);
      groups.set(key, bucket);
    }

    for (const { buys, sells } of groups.values()) {
      if (buys.length > 0 && sells.length > 0) {
        return { buy: buys[0], sell: sells[0] };
      }
    }
    return undefined;
  }

  /**
   * Reconciles every in-flight RESERVED/PENDING order: confirms it, reverts it to LIVE, or
   * leaves it be. Confirmation is checked every call regardless of `reservedUntil` - that
   * field only bounds how long a stuck reservation is kept before giving up on it.
   */
  async retryFailSwaps(): Promise<void> {
    const inFlight = await Order.find({ status: { $in: ["RESERVED", "PENDING"] } });
    const expired = (order: OrderDoc) => Boolean(order.reservedUntil && order.reservedUntil <= new Date());

    for (const order of inFlight) {
      if (!order.pendingTxHash) {
        if (expired(order)) await this.revertToLive(order._id!);
        continue;
      }

      const pendingTx = await this.client.getTransaction(order.pendingTxHash as Hex);

      if (pendingTx?.status === "committed") {
        await this.confirmTrade(order, pendingTx);
        continue;
      }

      if (!pendingTx || pendingTx.status === "rejected") {
        if (expired(order)) await this.revertToLive(order._id!);
        continue;
      }

      // Still pending in the mempool - only push the deadline out once it's actually due,
      // rather than resetting a full fresh TTL on every poll regardless of how close it is.
      if (expired(order)) {
        await Order.updateOne(
          { _id: order._id! },
          { $set: { reservedUntil: new Date(Date.now() + RESERVATION_TTL_MS) } },
        );
      }
    }
  }

  /** Resolves both legs of a confirmed settlement as FILLED and records the trade. */
  private async confirmTrade(order: OrderDoc, pendingTx: Awaited<ReturnType<ccc.Client["getTransaction"]>>): Promise<void> {
    const counterpart = await Order.findOne({
      pendingTxHash: order.pendingTxHash,
      _id: { $ne: order._id },
    });
    if (!counterpart) {
      // The other leg isn't visible yet (e.g. a replica lag) - retry next tick.
      return;
    }

    const buyOrder = order.direction === "BID" ? order : counterpart;
    const sellOrder = order.direction === "BID" ? counterpart : order;
    const txHash = order.pendingTxHash as Hex;

    if (!pendingTx?.transaction || pendingTx.blockNumber === undefined) return;

    await this.ingestionService.ingest({
      schemaVersion: 1,
      eventId: `trade-confirmed:${txHash}`,
      occurredAt: new Date().toISOString(),
      transactionHash: txHash,
      blockNumber: pendingTx.blockNumber.toString(),
      blockHash: pendingTx.blockHash,
      eventType: "trade-confirmed",
      buyOrderOutPoint: {
        txHash: buyOrder.outPoint!.txHash as Hex,
        index: buyOrder.outPoint!.index.toString(),
      },
      sellOrderOutPoint: {
        txHash: sellOrder.outPoint!.txHash as Hex,
        index: sellOrder.outPoint!.index.toString(),
      },
      trade: {
        settlementTxHash: txHash,
        buyerLockHash: buyOrder.ownerLockHash as Hex,
        sellerLockHash: sellOrder.ownerLockHash as Hex,
        xudtTypeHash: sellOrder.xudtTypeHash as Hex,
        tokenAmount: sellOrder.remainingAmount.toString(),
        price: sellOrder.pricePerToken.toString(),
        paidCapacity: sellOrder.pricePerToken.toString(),
        confirmedAtBlock: pendingTx.blockNumber.toString(),
      },
    } as BotEvent);
  }

  private async matchPendingOrders(): Promise<void> {
    const match = this.findMatch(this._pendingPairOrders);
    if (!match) return;

    try {
      const txHash = await this.executeTrade(match.buy, match.sell);
      console.info(
        `DexOrderBot matched buy ${match.buy._id} with sell ${match.sell._id}: ${txHash}`,
      );
    } catch (err) {
      console.error("DexOrderBot match execution failed:", err);
    }
  }

  private matchGroupKey(order: OrderDoc): string {
    return `${order.xudtTypeHash}:${order.remainingAmount}:${order.pricePerToken.toString()}`;
  }

  private async reserve(orderId: string): Promise<OrderDoc | null> {
    return Order.findOneAndUpdate(
      { _id: orderId, status: "LIVE" },
      { $set: { status: "RESERVED", reservedUntil: new Date(Date.now() + RESERVATION_TTL_MS) } },
      { new: true },
    );
  }

  private async resolveScanCursor(): Promise<bigint> {
    if (this.lastScannedBlock !== undefined) {
      return this.lastScannedBlock + 1n;
    }

    const [latest] = await Order.find().sort({ blockNumber: -1 }).limit(1);
    return latest ? BigInt(latest.blockNumber) + 1n : 0n;
  }

  private async indexOrderCell(cell: ccc.Cell): Promise<OrderDoc | undefined> {
    const id = `${cell.outPoint.txHash}:${cell.outPoint.index}`;
    if (await Order.exists({ _id: id })) return undefined;

    let decoded: DecodedDexOrderArgs;
    try {
      decoded = this.deserializeLockScriptAndArgs(cell.cellOutput.lock);
    } catch (err) {
      console.warn(`skipping dex order cell ${id}: ${(err as Error).message}`);
      return undefined;
    }

    if (decoded.direction === "ASK") {
      // A SELL order cell must hold exactly the declared xUDT and amount up front.
      if (!cell.cellOutput.type || cell.cellOutput.type.hash() !== decoded.udtTypeHash) {
        console.warn(`skipping dex order cell ${id}: missing or mismatched xUDT type script`);
        return undefined;
      }
      const heldAmount = this.decodeUdtAmount(cell.outputData);
      if (heldAmount === undefined || heldAmount !== decoded.tokenAmount) {
        console.warn(`skipping dex order cell ${id}: cell token amount does not match declared args`);
        return undefined;
      }
    } else {
      // A BUY order cell must hold plain CKB only - no type script, no token data.
      if (cell.cellOutput.type) {
        console.warn(`skipping dex order cell ${id}: BUY order cell must not carry a type script`);
        return undefined;
      }
      if (cell.cellOutput.capacity <= decoded.pricePerToken) {
        console.warn(`skipping dex order cell ${id}: BUY order capacity does not exceed its own price`);
        return undefined;
      }
    }

    const creatingTx = await this.client.getTransaction(cell.outPoint.txHash);
    if (!creatingTx || creatingTx.status !== "committed" || creatingTx.blockNumber === undefined) {
      return undefined;
    }

    // Trust the owner lock only if it appears among the creating tx's own inputs.
    const ownerLock = await this.findInputWithLockHash(
      creatingTx.transaction,
      decoded.makerLockHash,
    );
    if (!ownerLock) {
      console.warn(
        `skipping dex order cell ${id}: no creating-tx input matches maker lock hash ${decoded.makerLockHash}`,
      );
      return undefined;
    }

    const ownerAddress = ccc.Address.fromScript(ownerLock, this.client).toString();

    await this.ingestionService.ingest({
      schemaVersion: 1,
      eventId: `order-confirmed:${id}:${creatingTx.blockNumber}`,
      occurredAt: new Date().toISOString(),
      transactionHash: cell.outPoint.txHash,
      blockNumber: creatingTx.blockNumber.toString(),
      eventType: "order-confirmed",
      outPoint: { txHash: cell.outPoint.txHash, index: cell.outPoint.index.toString() },
      order: {
        lockScript: cell.cellOutput.lock,
        typeScript: cell.cellOutput.type,
        cellData: cell.outputData,
        capacity: cell.cellOutput.capacity.toString(),
        ownerLock,
        ownerLockHash: decoded.makerLockHash,
        ownerAddress,
        direction: decoded.direction,
        pricePerToken: decoded.pricePerToken.toString(),
        tokenAmount: decoded.tokenAmount.toString(),
        xudtTypeHash: decoded.udtTypeHash,
        blockNumber: creatingTx.blockNumber.toString(),
        txIndex: (creatingTx.txIndex ?? 0n).toString(),
      },
    } as BotEvent);

    return (await Order.findById(id)) ?? undefined;
  }

  /** Re-checks tracked LIVE/RESERVED orders for cancellations or fills made outside executeTrade. */
  private async sweepTrackedOrders(): Promise<void> {
    const tracked = await Order.find({ status: { $in: ["LIVE", "RESERVED"] } });
    for (const order of tracked) {
      await this.checkOrderLiveness(order);
    }
  }

  private async reconcileSpentOrder(order: OrderDoc): Promise<void> {
    if (order.status === "FILLED" || order.status === "CANCELED") return;

    let spendingTxHash: Hex | undefined;
    for await (const record of this.client.findTransactionsByLock(
      order.lockScript,
      null,
      false,
      "asc",
    )) {
      if (record.isInput) {
        spendingTxHash = record.txHash;
        break;
      }
    }

    // The indexer hasn't caught up with the spend yet; try again on the next sweep.
    if (!spendingTxHash) return;

    const spendingTx = await this.client.getTransaction(spendingTxHash);
    if (!spendingTx || spendingTx.status !== "committed") return;

    // Mirrors the contract's own rule: the spend is a maker cancellation iff one of its
    // inputs carries the maker's lock hash; otherwise it's a match settlement.
    const cancellationInput = await this.findInputWithLockHash(
      spendingTx.transaction,
      order.ownerLockHash as Hex,
    );

    if (!cancellationInput) {
      await this.markAsResolved(order._id!, "FILLED", spendingTxHash);
      return;
    }

    // Route through the same ingestion pipeline order-confirmed/trade-confirmed already
    // use, rather than writing the status directly - that's what actually pushes the WS
    // update (emitMakerOrders/emitOrderbook), not just the DB write.
    if (spendingTx.blockNumber === undefined || !spendingTx.blockHash) return;
    await this.ingestionService.ingest({
      schemaVersion: 1,
      eventId: `order-cancelled:${spendingTxHash}:${order._id}`,
      occurredAt: new Date().toISOString(),
      transactionHash: spendingTxHash,
      blockNumber: spendingTx.blockNumber.toString(),
      blockHash: spendingTx.blockHash,
      eventType: "order-cancelled",
      outPoint: { txHash: order.outPoint!.txHash as Hex, index: order.outPoint!.index.toString() },
      cancelledByTxHash: spendingTxHash,
    } as BotEvent);
  }

  private async revertToLive(orderId: string): Promise<void> {
    await Order.updateOne(
      { _id: orderId },
      { $set: { status: "LIVE", reservedUntil: null, pendingTxHash: null } },
    );
  }

  private async refreshPendingPairOrders(): Promise<void> {
    const live = await Order.find({ status: "LIVE" });
    this._pendingPairOrders = this.sort(live);
  }

  /** Finds the first input of `tx` whose previous cell's lock hashes to `lockHash`, resolving it on-chain. */
  private async findInputWithLockHash(
    tx: ccc.Transaction,
    lockHash: Hex,
  ): Promise<ccc.Script | undefined> {
    for (const input of tx.inputs) {
      const prevCell = await this.client.getCell(input.previousOutput);
      if (prevCell && prevCell.cellOutput.lock.hash() === lockHash) {
        return prevCell.cellOutput.lock;
      }
    }
    return undefined;
  }

  private decodeUdtAmount(outputData: Hex): bigint | undefined {
    const buf = toBuffer(outputData);
    if (buf.length < 16) return undefined;
    return ccc.numLeFromBytes(toHex(buf.subarray(0, 16)));
  }
}
