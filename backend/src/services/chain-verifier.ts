// Reads canonical CKB state so ingested events are checked against the chain rather than trusted.
import { ccc } from "@ckb-ccc/core";
import AppError from "./error.js";
import { Config, Hex, Script } from "../types/index.js";
import { getDeployment, getAssetType, createDeploymentClient } from "../../../shared/deployment.mjs";

export interface ChainOutput {
  lock: Script;
  type?: Script;
  capacity: bigint;
  data: Hex;
}

export interface ChainTransaction {
  status: string;
  blockNumber?: bigint;
  blockHash?: Hex;
  txIndex?: bigint;
  inputs: Array<{ txHash: Hex; index: string }>;
  outputs: ChainOutput[];
  /** Lock hashes of the cells this transaction consumes, in input order. */
  inputLockHashes: Hex[];
}

/** The narrow slice of the chain the ingestion pipeline depends on. */
export interface ChainReader {
  getTip(): Promise<bigint>;
  /** Uncached lookup; undefined when the node does not know the transaction. */
  getTransaction(txHash: Hex): Promise<ChainTransaction | undefined>;
  /** Hash of the block currently canonical at `blockNumber`, or undefined beyond the tip. */
  getCanonicalBlockHash(blockNumber: bigint): Promise<Hex | undefined>;
}

export interface ChainVerification {
  chain: ChainReader;
  dexLock: Script;
  confirmationDepth: number;
  supportedAssetHashes: ReadonlySet<string>;
}

const scriptOf = (script: ccc.Script): Script => ({
  codeHash: script.codeHash as Hex,
  hashType: script.hashType,
  args: script.args as Hex,
});

export class CkbChainReader implements ChainReader {
  constructor(private readonly client: ccc.Client) {}

  getTip(): Promise<bigint> {
    return this.client.getTip();
  }

  async getTransaction(txHash: Hex): Promise<ChainTransaction | undefined> {
    // NoCache: a cached response could outlive a reorg or a dropped transaction.
    const response = await this.client.getTransactionNoCache(txHash);
    if (!response) return undefined;

    const tx = response.transaction;
    const inputLockHashes: Hex[] = [];
    for (const input of tx.inputs) {
      const previous = await this.client.getCell(input.previousOutput);
      if (previous) inputLockHashes.push(previous.cellOutput.lock.hash() as Hex);
    }

    return {
      status: response.status,
      blockNumber: response.blockNumber,
      blockHash: response.blockHash,
      txIndex: response.txIndex,
      inputs: tx.inputs.map((input) => ({
        txHash: input.previousOutput.txHash as Hex,
        index: input.previousOutput.index.toString(),
      })),
      outputs: tx.outputs.map((output, index) => ({
        lock: scriptOf(output.lock),
        type: output.type ? scriptOf(output.type) : undefined,
        capacity: output.capacity,
        data: (tx.outputsData[index] ?? "0x") as Hex,
      })),
      inputLockHashes,
    };
  }

  async getCanonicalBlockHash(blockNumber: bigint): Promise<Hex | undefined> {
    const header = await this.client.getHeaderByNumberNoCache(blockNumber);
    return header?.hash as Hex | undefined;
  }
}

let registered: ChainVerification | undefined;

/** Installs the verification context at startup; ingestion fails closed until one exists. */
export function registerChainVerification(verification: ChainVerification | undefined): void {
  registered = verification;
}

export function getChainVerification(): ChainVerification {
  if (!registered) {
    throw new AppError(503, "Chain verification is not configured; refusing to ingest events");
  }
  return registered;
}

/** Builds the verification context from the same manifest the bot trusts. */
export function createChainVerification(config: Config): ChainVerification {
  const deployment = getDeployment(config.ckbNetwork);
  const client = createDeploymentClient(ccc, deployment, config.ckbRpcUrl);
  return {
    chain: new CkbChainReader(client),
    dexLock: config.dexOrderLockScript,
    confirmationDepth: config.confirmationDepth,
    supportedAssetHashes: new Set(
      deployment.assets.map((asset: { id: string }) => ccc.Script.from(getAssetType(deployment, asset.id)).hash()),
    ),
  };
}
