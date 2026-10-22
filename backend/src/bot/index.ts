// Indexes DEX order cells, matches compatible bid/ask pairs, and submits settlement transactions.
import { ccc } from "@ckb-ccc/core";
import type { HydratedDocumentFromSchema } from "mongoose";
import Order, { OrderSchema } from "../models/order.js";
import ChainCheckpoint from "../models/checkpoint.js";
import { Config, Hex, Script } from "../types/index.js";
import type { BotEvent } from "../schemas/bot-events.js";
import AppError from "../services/error.js";
import { EventIngestionService } from "../services/event-ingestion.js";
import { toBuffer, toHex } from "../utils/index.js";
import { getDeployment, getAssetType, createDeploymentClient, verifyDeployment, assertDexConfiguration } from "../../../shared/deployment.mjs";
import { MatchHealth, ORDER_QUARANTINE_MS } from "./match-health.js";
import { allocateSettlementCapacity } from "../../../shared/settlement-capacity.mjs";

export type OrderDoc = HydratedDocumentFromSchema<typeof OrderSchema>;

export { decodeDexOrderArgs } from "../utils/dex-order-args.js";
export type { DecodedDexOrderArgs } from "../utils/dex-order-args.js";
import { decodeDexOrderArgs, type DecodedDexOrderArgs } from "../utils/dex-order-args.js";

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
/** Checkpoints kept, and how many are compared per tick when looking for the fork point. */
const CHECKPOINT_RETENTION = 500;
const CHECKPOINT_WINDOW = 50;
const MAX_MATCHES_PER_TICK = 10;
const RESERVATION_TTL_MS = 5 * 60 * 1_000;
// Matches the fixed fee rate the UI uses for its own order transactions (see ui/src/lib/dex.ts).
const SETTLEMENT_FEE_RATE = 1_000n;

export default class DexOrderBot implements DexOrderBotTrait {
  readonly config: Config;
  readonly pollInterval: number;

  private readonly client: ccc.Client;
  private readonly dexCellDeps: ccc.CellDepLike[];
  private readonly xudtCellDeps: ccc.CellDepLike[];
  private readonly supportedAssetHashes: Set<string>;
  private readonly ingestionService = new EventIngestionService();

  private _pendingPairOrders: OrderDoc[] = [];
  private _health: MatchHealth | undefined;
  private ticking = false;
  private pollTimer: ReturnType<typeof setInterval> | undefined;

  constructor(config: Config, pollInterval: number = DEFAULT_POLL_INTERVAL_MS) {
    this.config = config;
    this.pollInterval = pollInterval;

    const deployment = getDeployment(config.ckbNetwork);
    assertDexConfiguration(deployment, config.dexOrderLockScript);
    this.client = createDeploymentClient(ccc, deployment, config.ckbRpcUrl);
    this.dexCellDeps = deployment.dex.cellDeps.map(({ cellDep }) => cellDep);
    this.xudtCellDeps = deployment.knownScripts.XUdt.cellDeps.map(({ cellDep }) => cellDep);
    this.supportedAssetHashes = new Set(deployment.assets.map((asset) =>
      ccc.Script.from(getAssetType(deployment, asset.id)).hash()));
  }

  async init(): Promise<void> {
    await verifyDeployment(ccc, this.client, getDeployment(this.config.ckbNetwork));
  }

  get pendingPairOrders(): OrderDoc[] {
    return this._pendingPairOrders;
  }

  /** Starts the poll loop: scan -> reconcile liveness -> sweep stale reservations -> refresh book -> match. */
  start(): void {
    if (this.pollTimer) return;

    const tick = async () => {
      // A slow tick (RPC stalls, many orders) must not overlap the next one: two concurrent
      // ticks would race to reserve and settle the same orders.
      if (this.ticking) return;
      this.ticking = true;
      try {
        await this.init();
        await this.detectReorg();
        await this.scanForPendingOrders();
        await this.sweepTrackedOrders();
        await this.retryFailSwaps();
        await this.refreshPendingPairOrders();
        await this.matchPendingOrders();
      } catch (err) {
        console.error("DexOrderBot poll cycle failed:", err);
      } finally {
        this.ticking = false;
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
    // Only blocks buried `confirmationDepth` deep are indexed, so shallow reorgs never reach the DB.
    const safeTip = tip - BigInt(this.config.confirmationDepth);
    if (safeTip < 0n) return [];

    const fromBlock = await this.resolveScanCursor();
    if (fromBlock > safeTip) return [];

    // Pin the end block's hash before scanning; if it changes mid-scan the range is unreliable.
    const endHash = (await this.client.getHeaderByNumberNoCache(safeTip))?.hash as Hex | undefined;
    if (!endHash) return [];

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
      filter: { blockRange: [fromBlock, safeTip + 1n] },
      withData: true,
    };

    for await (const cell of this.client.findCells(searchKey, "asc")) {
      const order = await this.indexOrderCell(cell);
      if (order) discovered.push(order);
    }

    const endHashAfter = (await this.client.getHeaderByNumberNoCache(safeTip))?.hash;
    if (endHashAfter !== endHash) return discovered; // reorged mid-scan: leave the cursor, rescan next tick

    await this.saveCheckpoint(safeTip, endHash);
    return discovered;
  }

  /** Records the scanned block's hash (the persisted cursor) and trims history beyond the window. */
  private async saveCheckpoint(blockNumber: bigint, blockHash: Hex): Promise<void> {
    await ChainCheckpoint.updateOne(
      { blockNumber: Number(blockNumber) },
      { $set: { blockHash } },
      { upsert: true },
    );
    await ChainCheckpoint.deleteMany({ blockNumber: { $lt: Number(blockNumber) - CHECKPOINT_RETENTION } });
  }

  /**
   * Compares stored checkpoint hashes with the canonical chain. On a mismatch, tells the
   * backend to roll back everything above the last common block, then rewinds the cursor.
   */
  async detectReorg(): Promise<void> {
    const checkpoints = await ChainCheckpoint.find().sort({ blockNumber: -1 }).limit(CHECKPOINT_WINDOW).lean();
    if (checkpoints.length === 0) return;

    let ancestor: number | undefined;
    let evidence: { blockNumber: number; blockHash: string } | undefined;
    for (const checkpoint of checkpoints) {
      const canonical = (await this.client.getHeaderByNumberNoCache(checkpoint.blockNumber))?.hash;
      if (canonical === checkpoint.blockHash) {
        ancestor = checkpoint.blockNumber;
        break;
      }
      evidence = checkpoint;
    }
    if (!evidence) return; // newest checkpoint is still canonical

    // No common block inside the window: assume the fork point is just below its oldest entry.
    const oldest = checkpoints[checkpoints.length - 1].blockNumber;
    const ancestorBlock = ancestor ?? oldest - 1;

    console.warn(`DexOrderBot detected a reorg: rolling back above block ${ancestorBlock}`);
    await this.ingestionService.ingest({
      schemaVersion: 1,
      eventId: `chain-reorg:${evidence.blockNumber}:${evidence.blockHash}`,
      occurredAt: new Date().toISOString(),
      eventType: "chain-reorg",
      revertedBlockNumber: evidence.blockNumber.toString(),
      revertedBlockHash: evidence.blockHash as Hex,
      ancestorBlockNumber: ancestorBlock.toString(),
      reason: "checkpoint block hash no longer canonical",
    } as BotEvent);

    // Rewind only after the backend accepted the rollback, so a failure retries from the same state.
    await ChainCheckpoint.deleteMany({ blockNumber: { $gt: ancestorBlock } });
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
    if (!this.supportedAssetHashes.has(buyOrder.xudtTypeHash as string)) {
      throw new AppError(400, "Token type is not listed in the deployment manifest");
    }
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

    // Include dependencies before measuring the final transaction size and fee.
    tx.addCellDeps(this.dexCellDeps);
    tx.addCellDeps(this.xudtCellDeps);
    const allocation = allocateSettlementCapacity({
      buyCapacity: BigInt(buyOrder.capacity),
      price,
      minimumTokenCapacity: tx.outputs[1].capacity,
      fee: tx.estimateFee(SETTLEMENT_FEE_RATE),
    });
    if (!allocation) {
      throw new AppError(
        409,
        `buy order ${buyOrder._id} does not carry enough capacity to cover price + its token cell + the network fee`,
        "INSUFFICIENT_BUY_CAPACITY",
      );
    }

    tx.outputs[1].capacity = allocation.tokenCapacity;

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

      const txHash = await this.submit(tx);

      try {
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
      } catch (ingestErr) {
        // The transaction is already in the pool: releasing the orders now would let the bot
        // build a competing settlement. Track it as pending so reconciliation resolves it.
        console.error(`settlement ${txHash} submitted but not recorded; tracking directly`, ingestErr);
        await Order.updateMany(
          { _id: { $in: [reservedBuy._id!, reservedSell._id!] } },
          { $set: { status: "PENDING", pendingTxHash: txHash, settlementTxHash: txHash } },
        );
      }

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
   * Sends the settlement, translating node rejections caused by other matchers racing us:
   * an identical tx already in the pool is success; a spent input or a conflicting pool tx
   * means someone else is settling these orders.
   */
  private async submit(tx: ccc.Transaction): Promise<Hex> {
    try {
      return await this.client.sendTransaction(tx);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/duplicat/i.test(message)) {
        return tx.hash() as Hex; // the same transaction is already pending: adopt it
      }
      if (/Dead|Unknown\(OutPoint|FailedToResolve|Resolve/i.test(message)) {
        throw new AppError(409, "a matched order cell was already spent on-chain", "ORDER_SPENT");
      }
      if (/RBF|conflict|PoolRejected/i.test(message)) {
        throw new AppError(409, "a competing settlement for these orders is already pending", "COMPETING_SETTLEMENT");
      }
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
   * Every non-overlapping exact-match pair, best priority first. Quarantined orders and pairs
   * in backoff are skipped, so a pair that keeps failing never hides the other matches.
   */
  findMatches(orders: OrderDoc[], now: number = Date.now()): Array<{ buy: OrderDoc; sell: OrderDoc }> {
    const groups = new Map<string, { buys: OrderDoc[]; sells: OrderDoc[] }>();
    for (const order of this.sort(orders)) {
      if (this.health.isOrderQuarantined(order._id!, now)) continue;
      const key = this.matchGroupKey(order);
      const bucket = groups.get(key) ?? { buys: [], sells: [] };
      (order.direction === "BID" ? bucket.buys : bucket.sells).push(order);
      groups.set(key, bucket);
    }

    const pairs: Array<{ buy: OrderDoc; sell: OrderDoc }> = [];
    for (const { buys, sells } of groups.values()) {
      const taken = new Set<string>();
      for (const buy of buys) {
        const sell = sells.find((candidate) =>
          !taken.has(candidate._id!) && !this.health.isPairBlocked(buy._id!, candidate._id!, now));
        if (!sell) continue;
        taken.add(sell._id!);
        pairs.push({ buy, sell });
      }
    }
    return pairs;
  }

  private get health(): MatchHealth {
    return (this._health ??= new MatchHealth());
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
        const recorded = await this.confirmTrade(order, pendingTx);
        // A leg that lost its counterpart (released, or reconciled separately) can never finish.
        if (!recorded && expired(order)) await this.revertToLive(order._id!);
        continue;
      }

      if (!pendingTx || pendingTx.status === "rejected") {
        // Our settlement is gone (dropped, rejected, or replaced). If another matcher's
        // transaction consumed the cell, reconcile that now instead of waiting out the TTL.
        if (!(await this.checkOrderLiveness(order))) continue;
        // "rejected" is final; "unknown" might just be node lag, so it waits for the TTL.
        if (pendingTx?.status === "rejected" || expired(order)) await this.revertToLive(order._id!);
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
  private async confirmTrade(order: OrderDoc, pendingTx: Awaited<ReturnType<ccc.Client["getTransaction"]>>): Promise<boolean> {
    const counterpart = await Order.findOne({
      pendingTxHash: order.pendingTxHash,
      _id: { $ne: order._id },
    });
    if (!counterpart) {
      // The other leg isn't visible yet (e.g. a replica lag) - retry next tick.
      return false;
    }

    const buyOrder = order.direction === "BID" ? order : counterpart;
    const sellOrder = order.direction === "BID" ? counterpart : order;
    const txHash = order.pendingTxHash as Hex;

    if (!pendingTx?.transaction || pendingTx.blockNumber === undefined) return false;

    await this.emit({
      schemaVersion: 1,
      eventId: `trade-confirmed:${txHash}:${pendingTx.blockHash}`,
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
    // Not yet buried deep enough counts as handled: it is simply retried on a later tick.
    return true;
  }

  /** Ingests an event; "not buried deep enough yet" is expected and simply retried next tick. */
  private async emit(event: BotEvent): Promise<boolean> {
    try {
      await this.ingestionService.ingest(event);
      return true;
    } catch (err) {
      if (err instanceof AppError && err.statusCode === 409) return false;
      throw err;
    }
  }

  private async matchPendingOrders(): Promise<void> {
    const live = new Set(this._pendingPairOrders.map((order) => order._id!));
    this.health.prune(live);

    for (const { buy, sell } of this.findMatches(this._pendingPairOrders).slice(0, MAX_MATCHES_PER_TICK)) {
      try {
        const txHash = await this.executeTrade(buy, sell);
        this.health.recordSuccess(buy._id!, sell._id!);
        console.info(`DexOrderBot matched buy ${buy._id} with sell ${sell._id}: ${txHash}`);
      } catch (err) {
        await this.handleMatchFailure(buy, sell, err);
      }
    }
  }

  /** One failed pair must only penalize itself (or its provably unsettleable order), never the book. */
  private async handleMatchFailure(buy: OrderDoc, sell: OrderDoc, err: unknown): Promise<void> {
    const code = err instanceof AppError ? err.code : undefined;

    if (code === "INSUFFICIENT_BUY_CAPACITY") {
      // The buy cell can never fund a settlement; every sell it would meet fails the same way.
      this.health.quarantineOrder(buy._id!, ORDER_QUARANTINE_MS);
    } else if (err instanceof AppError && err.statusCode === 400) {
      this.health.quarantineOrder(buy._id!);
      this.health.quarantineOrder(sell._id!);
    } else {
      const delay = this.health.recordPairFailure(buy._id!, sell._id!);
      if (code === "ORDER_SPENT" || code === "COMPETING_SETTLEMENT") {
        // Someone else is settling one of these: re-check the cells so the DB catches up now.
        await Promise.allSettled([this.checkOrderLiveness(buy), this.checkOrderLiveness(sell)]);
      }
      console.warn(`DexOrderBot pair ${buy._id}/${sell._id} backed off ${delay}ms`);
    }
    console.error("DexOrderBot match execution failed:", err);
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
    const [checkpoint] = await ChainCheckpoint.find().sort({ blockNumber: -1 }).limit(1).lean();
    if (checkpoint) return BigInt(checkpoint.blockNumber) + 1n;

    // Fresh checkpoint store (first run after upgrade): resume from the newest indexed order.
    const [latest] = await Order.find().sort({ blockNumber: -1 }).limit(1);
    return latest ? BigInt(latest.blockNumber) + 1n : 0n;
  }

  private async indexOrderCell(cell: ccc.Cell): Promise<OrderDoc | undefined> {
    const id = `${cell.outPoint.txHash}:${cell.outPoint.index}`;
    const known = await Order.findById(id, { status: 1 }).lean();
    if (known && known.status !== "ORPHANED") return undefined;

    let decoded: DecodedDexOrderArgs;
    try {
      decoded = this.deserializeLockScriptAndArgs(cell.cellOutput.lock);
    } catch (err) {
      console.warn(`skipping dex order cell ${id}: ${(err as Error).message}`);
      return undefined;
    }

    if (!this.supportedAssetHashes.has(decoded.udtTypeHash)) {
      console.warn(`skipping dex order cell ${id}: unsupported manifest asset`);
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

    await this.emit({
      schemaVersion: 1,
      eventId: `order-confirmed:${id}:${creatingTx.blockHash}`,
      occurredAt: new Date().toISOString(),
      transactionHash: cell.outPoint.txHash,
      blockNumber: creatingTx.blockNumber.toString(),
      blockHash: creatingTx.blockHash,
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

    // Orders with identical terms share one lock script, so a lock-indexed input record may
    // belong to a sibling order: only a committed tx that spends *this* outpoint counts.
    let spendingTxHash: Hex | undefined;
    let spendingTx: Awaited<ReturnType<ccc.Client["getTransaction"]>>;
    for await (const record of this.client.findTransactionsByLock(
      order.lockScript,
      null,
      false,
      "asc",
    )) {
      if (!record.isInput) continue;
      const candidate = await this.client.getTransaction(record.txHash);
      if (candidate?.status !== "committed") continue;
      const spendsOrder = candidate.transaction.inputs.some(
        (input) =>
          input.previousOutput.txHash === order.outPoint!.txHash &&
          input.previousOutput.index.toString() === order.outPoint!.index.toString(),
      );
      if (spendsOrder) {
        spendingTxHash = record.txHash;
        spendingTx = candidate;
        break;
      }
    }

    // The indexer hasn't caught up with the spend yet; try again on the next sweep.
    if (!spendingTxHash || !spendingTx) return;

    // Mirrors the contract's own rule: the spend is a maker cancellation iff one of its
    // inputs carries the maker's lock hash; otherwise it's a match settlement.
    const cancellationInput = await this.findInputWithLockHash(
      spendingTx.transaction,
      order.ownerLockHash as Hex,
    );

    if (!cancellationInput) {
      // Settled by another matcher (or a replaced transaction of ours): record it as a trade
      // through ingestion so it is chain-verified and buried before the orders turn FILLED.
      await this.confirmExternalSettlement(spendingTx);
      return;
    }

    // Route through the same ingestion pipeline order-confirmed/trade-confirmed already
    // use, rather than writing the status directly - that's what actually pushes the WS
    // update (emitMakerOrders/emitOrderbook), not just the DB write.
    if (spendingTx.blockNumber === undefined || !spendingTx.blockHash) return;
    await this.emit({
      schemaVersion: 1,
      eventId: `order-cancelled:${spendingTxHash}:${spendingTx.blockHash}:${order._id}`,
      occurredAt: new Date().toISOString(),
      transactionHash: spendingTxHash,
      blockNumber: spendingTx.blockNumber.toString(),
      blockHash: spendingTx.blockHash,
      eventType: "order-cancelled",
      outPoint: { txHash: order.outPoint!.txHash as Hex, index: order.outPoint!.index.toString() },
      cancelledByTxHash: spendingTxHash,
    } as BotEvent);
  }

  /** Emits trade-confirmed for a committed settlement that consumed two orders we track. */
  private async confirmExternalSettlement(
    spendingTx: NonNullable<Awaited<ReturnType<ccc.Client["getTransaction"]>>>,
  ): Promise<void> {
    if (spendingTx.blockNumber === undefined || !spendingTx.blockHash) return;

    const spentIds = spendingTx.transaction.inputs.map(
      (input) => `${input.previousOutput.txHash}:${input.previousOutput.index}`,
    );
    const orders = await Order.find({ _id: { $in: spentIds } });
    const buyOrder = orders.find((candidate) => candidate.direction === "BID");
    const sellOrder = orders.find((candidate) => candidate.direction === "ASK");
    if (!buyOrder || !sellOrder) return; // the counterpart is unknown to us; nothing safe to record

    const txHash = spendingTx.transaction.hash() as Hex;
    await this.emit({
      schemaVersion: 1,
      eventId: `trade-confirmed:${txHash}:${spendingTx.blockHash}`,
      occurredAt: new Date().toISOString(),
      transactionHash: txHash,
      blockNumber: spendingTx.blockNumber.toString(),
      blockHash: spendingTx.blockHash,
      eventType: "trade-confirmed",
      buyOrderOutPoint: { txHash: buyOrder.outPoint!.txHash as Hex, index: buyOrder.outPoint!.index.toString() },
      sellOrderOutPoint: { txHash: sellOrder.outPoint!.txHash as Hex, index: sellOrder.outPoint!.index.toString() },
      trade: {
        settlementTxHash: txHash,
        buyerLockHash: buyOrder.ownerLockHash as Hex,
        sellerLockHash: sellOrder.ownerLockHash as Hex,
        xudtTypeHash: sellOrder.xudtTypeHash as Hex,
        tokenAmount: sellOrder.remainingAmount.toString(),
        price: sellOrder.pricePerToken.toString(),
        paidCapacity: sellOrder.pricePerToken.toString(),
        confirmedAtBlock: spendingTx.blockNumber.toString(),
      },
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
