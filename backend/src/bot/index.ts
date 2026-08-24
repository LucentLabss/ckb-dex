import { ccc } from "@ckb-ccc/core";
import type { HydratedDocumentFromSchema } from "mongoose";
import Order, { OrderSchema } from "../models/order.js";
import { Config, Hex, OrderType, Script } from "../types";
import AppError from "../services/error.js";
import { toBuffer, toHex } from "../utils/index.js";
import dexScriptsJson from "../../../deployment/scripts.json" with { type: "json" };
import systemScriptsJson from "../../../deployment/system-scripts.json" with { type: "json" };

export type OrderDoc = HydratedDocumentFromSchema<typeof OrderSchema>;

/**
 * POC dex-order-lock args layout: makerLockHash(32) + orderType(1) + pricePerToken(8, LE).
 * The full owner lock script is deliberately NOT embedded on-chain yet - it is recovered
 * from the inputs of the transaction that created the order cell (see resolveOwnerLock).
 * A future production contract revision is expected to either carry the full owner lock
 * script in args or move it into a witness; this decoder targets the current POC layout.
 */
const MAKER_HASH_LENGTH = 32;
const ORDER_TYPE_LENGTH = 1;
const PRICE_LENGTH = 8;
const DEX_ORDER_ARGS_LENGTH = MAKER_HASH_LENGTH + ORDER_TYPE_LENGTH + PRICE_LENGTH;

export interface DecodedDexOrderArgs {
  makerLockHash: Hex;
  orderType: OrderType;
  pricePerToken: bigint;
}

function decodeDexOrderArgs(args: Hex): DecodedDexOrderArgs {
  const buf = toBuffer(args);
  if (buf.length !== DEX_ORDER_ARGS_LENGTH) {
    throw new AppError(
      400,
      `dex order args must be ${DEX_ORDER_ARGS_LENGTH} bytes, got ${buf.length}`,
    );
  }

  const orderType = buf.readUInt8(MAKER_HASH_LENGTH);
  if (orderType !== OrderType.ASK && orderType !== OrderType.BID) {
    throw new AppError(400, `unknown order type byte ${orderType}`);
  }

  return {
    makerLockHash: toHex(buf.subarray(0, MAKER_HASH_LENGTH)),
    orderType,
    pricePerToken: buf.readBigUInt64LE(MAKER_HASH_LENGTH + ORDER_TYPE_LENGTH),
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

function resolveXudtCellDeps(): ccc.CellDepLike[] {
  const xudt = (systemScriptsJson as Record<string, DeploymentScriptEntry>).XUdt;
  return xudt.cellDeps.map(({ cellDep }) => cellDep);
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
  executeTrade(order: OrderDoc, taker: ccc.Signer): Promise<Hex>;
  retryFailSwaps(): Promise<void>;
}

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const RESERVATION_TTL_MS = 5 * 60 * 1_000;

export default class DexOrderBot implements DexOrderBotTrait {
  readonly config: Config;
  readonly pollInterval: number;

  private readonly client: ccc.Client;
  private readonly dexCellDeps: ccc.CellDepLike[];
  private readonly xudtCellDeps: ccc.CellDepLike[];

  private _pendingPairOrders: OrderDoc[] = [];
  private lastScannedBlock: bigint | undefined;
  private pollTimer: ReturnType<typeof setInterval> | undefined;

  constructor(config: Config, pollInterval: number = DEFAULT_POLL_INTERVAL_MS) {
    this.config = config;
    this.pollInterval = pollInterval;

    this.client = new ccc.ClientPublicTestnet({
      url: config.ckbRpcUrl,
      scripts: systemScriptsJson as unknown as Record<
        ccc.KnownScript,
        ccc.ScriptInfoLike | undefined
      >,
    });

    this.dexCellDeps = resolveDexCellDeps(config.dexOrderLockScript);
    this.xudtCellDeps = resolveXudtCellDeps();
  }

  get pendingPairOrders(): OrderDoc[] {
    return this._pendingPairOrders;
  }

  /** Starts the poll loop: scan -> reconcile liveness -> sweep stale reservations -> refresh book. */
  start(): void {
    if (this.pollTimer) return;

    const tick = async () => {
      try {
        await this.scanForPendingOrders();
        await this.sweepTrackedOrders();
        await this.retryFailSwaps();
        await this.refreshPendingPairOrders();
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

      if (a.blockNumber !== b.blockNumber) return a.blockNumber - b.blockNumber;
      return a.txIndex - b.txIndex;
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

    // `findCells`'s public type omits `blockRange`, even though it's forwarded to the
    // indexer at runtime (see ClientIndexerSearchKeyFilterLike) - type via the wider key
    // first so this isn't flagged as an excess property on the literal.
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
   * Builds and submits the settlement transaction that fills a LIVE ASK order, paying the
   * maker (order.capacity + price) and delivering the tokens to the taker. Mirrors exactly
   * what the dex-order-lock contract's fill path validates (see smart-contract main.rs).
   */
  async executeTrade(order: OrderDoc, taker: ccc.Signer): Promise<Hex> {
    if (order.direction !== "ASK") {
      throw new AppError(400, `only ASK orders can be filled directly; got ${order.direction}`);
    }

    const reserved = await Order.findOneAndUpdate(
      { _id: order._id, status: "LIVE" },
      { $set: { status: "RESERVED", reservedUntil: new Date(Date.now() + RESERVATION_TTL_MS) } },
      { new: true },
    );
    if (!reserved) {
      throw new AppError(409, `order ${order._id} is not LIVE (already reserved or resolved)`);
    }

    try {
      const stillLive = await this.checkOrderLiveness(reserved);
      if (!stillLive) {
        throw new AppError(409, `order ${order._id} was already settled on-chain`);
      }

      const orderCapacity = BigInt(reserved.capacity);
      const askPrice = BigInt(reserved.pricePerToken.toString());
      const takerLock = (await taker.getRecommendedAddressObj()).script;

      const tx = ccc.Transaction.from({
        inputs: [
          {
            previousOutput: {
              txHash: reserved.outPoint!.txHash,
              index: reserved.outPoint!.index,
            },
            since: 0,
          },
        ],
        outputs: [
          { capacity: orderCapacity + askPrice, lock: reserved.ownerLock },
          { capacity: orderCapacity, lock: takerLock, type: reserved.typeScript },
        ],
        outputsData: ["0x", reserved.cellData as Hex],
      });

      tx.addCellDeps(this.dexCellDeps);
      tx.addCellDeps(this.xudtCellDeps);

      await tx.completeInputsByCapacity(taker);
      await tx.completeFeeBy(taker, 1_000);

      const txHash = await taker.sendTransaction(tx);

      await Order.updateOne(
        { _id: reserved._id },
        { $set: { status: "PENDING", pendingTxHash: txHash } },
      );

      return txHash;
    } catch (err) {
      await this.revertToLive(reserved._id!);
      throw err;
    }
  }

  /** Sweeps expired RESERVED/PENDING orders: confirms, reverts to LIVE, or extends the reservation. */
  async retryFailSwaps(): Promise<void> {
    const expired = await Order.find({
      status: { $in: ["RESERVED", "PENDING"] },
      reservedUntil: { $ne: null, $lte: new Date() },
    });

    for (const order of expired) {
      if (!order.pendingTxHash) {
        await this.revertToLive(order._id!);
        continue;
      }

      const pendingTx = await this.client.getTransaction(order.pendingTxHash as Hex);

      if (pendingTx?.status === "committed") {
        await this.markAsResolved(order._id!, "FILLED", order.pendingTxHash as Hex);
        continue;
      }

      if (!pendingTx || pendingTx.status === "rejected") {
        await this.revertToLive(order._id!);
        continue;
      }

      // Still pending in the mempool - give it more time before sweeping again.
      await Order.updateOne(
        { _id: order._id! },
        { $set: { reservedUntil: new Date(Date.now() + RESERVATION_TTL_MS) } },
      );
    }
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

    if (!cell.cellOutput.type) {
      console.warn(`skipping dex order cell ${id}: missing type script`);
      return undefined;
    }

    let decoded: DecodedDexOrderArgs;
    try {
      decoded = this.deserializeLockScriptAndArgs(cell.cellOutput.lock);
    } catch (err) {
      console.warn(`skipping dex order cell ${id}: ${(err as Error).message}`);
      return undefined;
    }

    const creatingTx = await this.client.getTransaction(cell.outPoint.txHash);
    if (!creatingTx || creatingTx.status !== "committed" || creatingTx.blockNumber === undefined) {
      return undefined;
    }

    // The dex-order-lock script never runs at cell creation (only when spent), so the
    // makerLockHash in args is unauthenticated on its own. We recover - and trust - the
    // real owner lock only if it appears among the creating transaction's own inputs,
    // since spending an input requires a valid signature from its owner.
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
    const remainingAmount = this.decodeUdtAmount(cell.outputData);
    if (remainingAmount === undefined) {
      console.warn(`skipping dex order cell ${id}: malformed xUDT amount`);
      return undefined;
    }

    return Order.findOneAndUpdate(
      { _id: id },
      {
        $setOnInsert: {
          _id: id,
          outPoint: { txHash: cell.outPoint.txHash, index: Number(cell.outPoint.index) },
          lockScript: cell.cellOutput.lock,
          typeScript: cell.cellOutput.type,
          cellData: cell.outputData,
          capacity: cell.cellOutput.capacity.toString(),
          ownerLock,
          ownerLockHash: decoded.makerLockHash,
          ownerAddress,
          direction: decoded.orderType === OrderType.BID ? "BID" : "ASK",
          pricePerToken: decoded.pricePerToken.toString(),
          remainingAmount: remainingAmount.toString(),
          tokenPair: `${cell.cellOutput.type.hash()}:CKB`,
          udtTypeHash: cell.cellOutput.type.hash(),
          blockNumber: Number(creatingTx.blockNumber),
          txIndex: Number(creatingTx.txIndex ?? 0n),
          status: "LIVE",
        },
      },
      { upsert: true, new: true },
    );
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
    // inputs carries the maker's lock hash; otherwise it's a taker fill.
    const cancellationInput = await this.findInputWithLockHash(
      spendingTx.transaction,
      order.ownerLockHash as Hex,
    );

    await this.markAsResolved(
      order._id!,
      cancellationInput ? "CANCELED" : "FILLED",
      spendingTxHash,
    );
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
