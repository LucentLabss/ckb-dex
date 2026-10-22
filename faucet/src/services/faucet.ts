import { ccc } from "@ckb-ccc/core";
import ClaimStore from "./claims.js";
import Mutex from "../utils/mutex.js";
import AppError from "./error.js";
import { Config, Hex } from "../types.js";
import { getDeployment, getAssetType, createDeploymentClient, verifyDeployment } from "../../../shared/deployment.mjs";

/**
 * A standalone drip faucet for the demo xUDT token. Mints fresh supply on every claim
 * (owner-mode xUDT: an input carrying the issuer's own lock authorizes minting, so there's
 * no pooled balance to run dry - only the issuer's CKB balance, which funds each output's
 * capacity and the tx fee, needs periodic top-ups from a public testnet CKB faucet).
 */
/** A reservation that never reached "sent" this long ago is assumed abandoned. */
const RESERVATION_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_ADDRESS_LENGTH = 256;

export default class TokenFaucet {
  readonly config: Config;

  private readonly client: ccc.Client;
  private readonly signer: ccc.SignerCkbPrivateKey;
  private readonly xudtCellDeps: ccc.CellDepLike[];

  readonly claims: ClaimStore;
  // One send at a time: concurrent builds would pick the same issuer cells and double-spend.
  private readonly sendLock = new Mutex();

  private issuerLock: ccc.Script | undefined;
  private issuerLockHash: Hex | undefined;

  constructor(config: Config) {
    this.config = config;

    const deployment = getDeployment(config.ckbNetwork);
    if (deployment.network !== "testnet") {
      throw new Error(`The demo faucet only runs on testnet (manifest network: ${deployment.network})`);
    }
    this.client = createDeploymentClient(ccc, deployment, config.ckbRpcUrl);
    this.signer = new ccc.SignerCkbPrivateKey(this.client, config.issuerPrivateKey);
    const xudt = deployment.knownScripts.XUdt;
    this.xudtCellDeps = xudt.cellDeps.map(({ cellDep }) => cellDep);
    this.claims = new ClaimStore({
      cooldownMs: config.cooldownHours * 60 * 60 * 1000,
      reservationTimeoutMs: RESERVATION_TIMEOUT_MS,
      dripAmount: config.dripAmount,
      dailyMaxClaims: config.dailyMaxClaims,
      dailyMaxTokens: config.dailyMaxTokens,
    });
  }

  /** Verify the chain and issuer against the shared deployment before serving claims. */
  async init(): Promise<void> {
    await verifyDeployment(ccc, this.client, getDeployment(this.config.ckbNetwork));
    const address = await this.signer.getAddressObjSecp256k1();
    this.issuerLock = address.script;
    this.issuerLockHash = this.issuerLock.hash() as Hex;
    const expectedType = getAssetType(getDeployment(this.config.ckbNetwork));
    const expectedIssuer = ccc.hexFrom(ccc.bytesFrom(expectedType.args).slice(0, 32));
    if (this.issuerLockHash !== expectedIssuer) {
      throw new Error("Faucet issuer does not match the manifest token issuer");
    }

    const balance = await this.client.getBalanceSingle(this.issuerLock);

    console.log("Faucet issuer address:", address.toString());
    console.log("Faucet issuer lock hash:", this.issuerLockHash);
    console.log("Faucet issuer CKB balance:", ccc.fixedPointToString(balance));
  }

  private get xudtType(): ccc.Script {
    if (!this.issuerLockHash) {
      throw new AppError(500, "TokenFaucet.init() must run before serving claims");
    }
    return ccc.Script.from(getAssetType(getDeployment(this.config.ckbNetwork)));
  }

  /**
   * Sends `config.dripAmount` of the demo token to `addressLike`, subject to the per-recipient
   * cooldown and the global daily budget. The cooldown and budget are reserved atomically
   * before anything is sent and rolled back if the send fails. Returns the tx hash.
   */
  async claim(addressLike: string): Promise<Hex> {
    if (addressLike.length > MAX_ADDRESS_LENGTH) {
      throw new AppError(400, "Invalid address");
    }

    let recipientLock: ccc.Script;
    try {
      recipientLock = (await ccc.Address.fromString(addressLike, this.client)).script;
    } catch {
      throw new AppError(400, "Invalid address for this network");
    }
    const lockHash = recipientLock.hash() as Hex;

    const reservation = await this.claims.reserve(lockHash, addressLike);

    let txHash: Hex;
    try {
      txHash = await this.sendLock.run(() => this.send(recipientLock));
    } catch (error) {
      await this.claims.release(reservation).catch((releaseError) => {
        console.error("Failed to release a faucet reservation", releaseError);
      });
      throw error;
    }

    // The transaction is out: from here the claim counts even if bookkeeping hiccups, so retry
    // rather than release.
    for (let attempt = 1; ; attempt++) {
      try {
        await this.claims.commit(reservation, txHash);
        break;
      } catch (error) {
        if (attempt >= 3) {
          console.error(`Faucet claim ${txHash} sent but not recorded`, error);
          break;
        }
      }
    }

    return txHash;
  }

  private async send(recipientLock: ccc.Script): Promise<Hex> {
    const tokenData = ccc.numLeToBytes(this.config.dripAmount, 16);

    const tx = ccc.Transaction.from({
      outputs: [{ lock: recipientLock, type: this.xudtType }],
      outputsData: [ccc.hexFrom(tokenData)],
    });

    tx.addCellDeps(this.xudtCellDeps);

    await tx.completeInputsByCapacity(this.signer);
    await tx.completeFeeBy(this.signer, 1_000);

    return (await this.signer.sendTransaction(tx)) as Hex;
  }
}
