import { ccc } from "@ckb-ccc/core";
import FaucetClaim from "../models/claim.js";
import AppError from "./error.js";
import { Config, Hex } from "../types.js";
import { getDeployment, getAssetType, createDeploymentClient, verifyDeployment } from "../../../shared/deployment.mjs";

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

  private issuerLock: ccc.Script | undefined;
  private issuerLockHash: Hex | undefined;

  constructor(config: Config) {
    this.config = config;

    const deployment = getDeployment(config.ckbNetwork);
    if (deployment.network === "mainnet") {
      throw new Error("The demo faucet is not available on mainnet");
    }
    this.client = createDeploymentClient(ccc, deployment, config.ckbRpcUrl);
    this.signer = new ccc.SignerCkbPrivateKey(this.client, config.issuerPrivateKey);
    const xudt = deployment.knownScripts.XUdt;
    this.xudtCellDeps = xudt.cellDeps.map(({ cellDep }) => cellDep);
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
