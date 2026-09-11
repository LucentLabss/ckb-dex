import { ccc } from "@ckb-ccc/core";
import scriptsJson from "../../../deployment/scripts.json";
import systemScriptsJson from "../../../deployment/system-scripts.json";

export type Hex = `0x${string}`;

interface DeploymentScriptEntry {
  codeHash: string;
  hashType: string;
  cellDeps: { cellDep: ccc.CellDepLike }[];
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

export const DEX_NETWORK = (import.meta.env.VITE_DEX_NETWORK as string | undefined) ?? "devnet";

const dexDeployment = (
  scriptsJson as Record<string, Record<string, DeploymentScriptEntry | undefined>>
)[DEX_NETWORK]?.["dex-order-lock"];

if (!dexDeployment) {
  throw new Error(
    `No dex-order-lock deployment found for network "${DEX_NETWORK}" in deployment/scripts.json`,
  );
}

const systemScriptsForNetwork = (
  systemScriptsJson as Record<string, Record<string, OffckbScriptEntry> | undefined>
)[DEX_NETWORK];

if (!systemScriptsForNetwork) {
  throw new Error(
    `No system-scripts entries for network "${DEX_NETWORK}" in deployment/system-scripts.json`,
  );
}

const xudtEntry = systemScriptsForNetwork.xudt;
if (!xudtEntry) {
  throw new Error(`No "xudt" system-script entry for network "${DEX_NETWORK}"`);
}
const xudtDeployment = xudtEntry.script;

// Only devnet needs a custom `scripts` override for the CKB client - ccc's
// ClientPublicTestnet already ships a complete, accurate built-in registry for testnet
// (TESTNET_SCRIPTS) covering everything, including wallet-bridging locks like PWLock and
// JoyID that offckb doesn't export at all. Overriding wholesale for testnet would silently
// drop any script we didn't hand-map, breaking wallets that need it (see the "No script
// information was found for PWLock on ckt" error connecting MetaMask). On mainnet ccc has
// its own built-in registry too, so the same reasoning applies there.
export const systemScripts: Record<ccc.KnownScript, ccc.ScriptInfoLike | undefined> | undefined =
  DEX_NETWORK === "devnet"
    ? (() => {
        const known: Record<string, ccc.ScriptInfoLike> = {};
        for (const [snakeName, entry] of Object.entries(systemScriptsForNetwork)) {
          const knownName = KNOWN_SCRIPT_NAME_MAP[snakeName];
          if (!knownName) continue;
          known[knownName] = {
            codeHash: entry.script.codeHash,
            hashType: entry.script.hashType,
            cellDeps: entry.script.cellDeps,
          };
        }
        return known as unknown as Record<ccc.KnownScript, ccc.ScriptInfoLike | undefined>;
      })()
    : undefined;

export const dexCellDeps: ccc.CellDepLike[] = dexDeployment.cellDeps.map(({ cellDep }) => cellDep);
export const xudtCellDeps: ccc.CellDepLike[] = xudtDeployment.cellDeps.map(({ cellDep }) => cellDep);

export const dexScript = {
  codeHash: dexDeployment.codeHash as Hex,
  hashType: dexDeployment.hashType as ccc.HashTypeLike,
};

// The demo token's xUDT args are `issuerLockHash(32) + 0x00000000` (see offchain/src/issue-token.ts).
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
 * Cancels a live order cell. The dex-order-lock treats the spend as authorized once one
 * of the tx's other inputs carries the maker's own lock hash (see program_entry in
 * main.rs) - ensured explicitly below, since completeInputsByCapacity won't add one if
 * the order's own capacity already covers the output and fee.
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
