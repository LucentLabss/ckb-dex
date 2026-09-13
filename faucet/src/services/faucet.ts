import { ccc } from "@ckb-ccc/core";
import FaucetClaim from "../models/claim.js";
import AppError from "./error.js";
import { Config, Hex } from "../types.js";
import systemScriptsJson from "../../../deployment/system-scripts.json" with { type: "json" };

interface DeploymentScriptEntry {
  codeHash: string;
  hashType: string;
  cellDeps: { cellDep: ccc.CellDepLike }[];
}

/**
 * `offckb system-scripts --export-style ccc` output shape: nested by network, each script
 * keyed by its own snake_case name (not ccc's KnownScript names), with codeHash/hashType/
 * cellDeps under a `.script` sub-object rather than at the top level.
 */
interface OffckbScriptEntry {
  name: string;
  script: DeploymentScriptEntry;
}

// The handful of well-known scripts this app actually touches, mapped from offckb's
// snake_case names to ccc's KnownScript names. Extend as needed - anything not listed
// here is simply left out of the flat `scripts` override passed to the CKB client.
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
      // ScriptInfoLike.cellDeps wants the wrapped {cellDep}[] form - same shape the JSON
      // already has, unlike tx.addCellDeps() below which wants it unwrapped.
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

/**
 * A standalone drip faucet for the demo xUDT token. Mints fresh supply on every claim
 * (owner-mode xUDT: an input carrying the issuer's own lock authorizes minting, so there's
 * no pooled balance to run dry - only the issuer's CKB balance, which funds each output's
 * capacity and the tx fee, needs periodic top-ups from a public testnet CKB faucet).
 */
export default class TokenFaucet {
  readonly config: Config;

  private readonly client: ccc.Client;
  private readonly signer: ccc.SignerCkbPrivateKey;
  private readonly xudtCellDeps: ccc.CellDepLike[];
  private readonly xudtCodeHash: Hex;
  private readonly xudtHashType: ccc.HashTypeLike;

  private issuerLock: ccc.Script | undefined;
  private issuerLockHash: Hex | undefined;

  constructor(config: Config) {
    this.config = config;

    const { known, raw } = resolveNetworkScripts(config.ckbNetwork);

    this.client = new ccc.ClientPublicTestnet({
      url: config.ckbRpcUrl,
      scripts: known as unknown as Record<ccc.KnownScript, ccc.ScriptInfoLike | undefined>,
    });

    this.signer = new ccc.SignerCkbPrivateKey(this.client, config.issuerPrivateKey);
    this.xudtCellDeps = resolveXudtCellDeps(raw, config.ckbNetwork);

    const xudt = raw.xudt;
    if (!xudt) {
      throw new AppError(500, `No "xudt" system-script entry for network "${config.ckbNetwork}"`);
    }
    this.xudtCodeHash = xudt.script.codeHash as Hex;
    this.xudtHashType = xudt.script.hashType as ccc.HashTypeLike;
  }

  /** Resolves and logs the issuer identity - the value ui/.env's VITE_XUDT_ISSUER_LOCK_HASH must match. */
  async init(): Promise<void> {
    const address = await this.signer.getAddressObjSecp256k1();
    this.issuerLock = address.script;
    this.issuerLockHash = this.issuerLock.hash() as Hex;

    const balance = await this.client.getBalanceSingle(this.issuerLock);

    console.log("Faucet issuer address:", address.toString());
    console.log("Faucet issuer lock hash:", this.issuerLockHash);
    console.log("Faucet issuer CKB balance:", ccc.fixedPointToString(balance));
  }

  private get xudtType(): ccc.Script {
    if (!this.issuerLockHash) {
      throw new AppError(500, "TokenFaucet.init() must run before serving claims");
    }
    return ccc.Script.from({
      codeHash: this.xudtCodeHash,
      hashType: this.xudtHashType,
      args: ccc.hexFrom(ccc.bytesConcat(ccc.bytesFrom(this.issuerLockHash), new Uint8Array(4))),
    });
  }

  /**
   * Sends `config.dripAmount` of the demo token to `addressLike`, subject to the
   * per-recipient cooldown. Returns the settlement tx hash.
   */
  async claim(addressLike: string): Promise<Hex> {
    const recipient = await ccc.Address.fromString(addressLike, this.client);
    const recipientLock = recipient.script;
    const lockHash = recipientLock.hash() as Hex;

    const existing = await FaucetClaim.findById(lockHash);
    const cooldownMs = this.config.cooldownHours * 60 * 60 * 1000;
    if (existing) {
      const elapsedMs = Date.now() - existing.lastClaimedAt.getTime();
      if (elapsedMs < cooldownMs) {
        const retryAfterSeconds = Math.ceil((cooldownMs - elapsedMs) / 1000);
        throw new AppError(
          429,
          `This address already claimed - try again in ${retryAfterSeconds}s`,
        );
      }
    }

    const tokenData = ccc.numLeToBytes(this.config.dripAmount, 16);

    const tx = ccc.Transaction.from({
      outputs: [{ lock: recipientLock, type: this.xudtType }],
      outputsData: [ccc.hexFrom(tokenData)],
    });

    tx.addCellDeps(this.xudtCellDeps);

    await tx.completeInputsByCapacity(this.signer);
    await tx.completeFeeBy(this.signer, 1_000);

    const txHash = (await this.signer.sendTransaction(tx)) as Hex;

    await FaucetClaim.findByIdAndUpdate(
      lockHash,
      {
        $set: { address: addressLike, lastClaimedAt: new Date(), lastTxHash: txHash },
        $inc: { claimCount: 1 },
      },
      { upsert: true },
    );

    return txHash;
  }
}
