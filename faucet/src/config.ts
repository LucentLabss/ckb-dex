import * as dotenv from "dotenv";
import AppError from "./services/error.js";
import { CkbNetwork, Config, Hex } from "./types.js";

dotenv.config();

const VALID_CKB_NETWORKS: CkbNetwork[] = ["devnet", "testnet", "mainnet"];

/** The faucet mints demo tokens from a hot key, so it must never run against a real network. */
function parseCkbNetwork(value: string | undefined): CkbNetwork {
  if (value == undefined || value.trim() === "") {
    return "testnet";
  }
  if (!VALID_CKB_NETWORKS.includes(value as CkbNetwork)) {
    throw new AppError(500, `Invalid CKB_NETWORK "${value}" (expected devnet, testnet or mainnet)`);
  }
  if (value !== "testnet") {
    throw new AppError(500, `The demo faucet only runs on testnet (got CKB_NETWORK="${value}")`);
  }
  return value as CkbNetwork;
}

function parsePositiveInteger(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new AppError(500, `${name} must be a positive integer`);
  }
  return parsed;
}

function parsePositiveBigInt(name: string, value: string | undefined, fallback: bigint): bigint {
  if (value === undefined || value.trim() === "") return fallback;
  if (!/^\d+$/.test(value.trim()) || BigInt(value.trim()) <= 0n) {
    throw new AppError(500, `${name} must be a positive integer`);
  }
  return BigInt(value.trim());
}

export default class AppConfiguration {
  config: Config | undefined;

  async getEnvironment(): Promise<Config> {
    const envs = process.env;

    const issuerPrivateKey = envs.FAUCET_ISSUER_PRIVATE_KEY as Hex | undefined;
    if (!issuerPrivateKey) {
      throw new AppError(500, "FAUCET_ISSUER_PRIVATE_KEY is missing from the environment");
    }

    const dripAmount = parsePositiveBigInt("FAUCET_DRIP_AMOUNT", envs.FAUCET_DRIP_AMOUNT, 100n);
    const dailyMaxClaims = parsePositiveInteger("FAUCET_DAILY_MAX_CLAIMS", envs.FAUCET_DAILY_MAX_CLAIMS, 500);
    const dailyMaxTokens = parsePositiveBigInt("FAUCET_DAILY_MAX_TOKENS", envs.FAUCET_DAILY_MAX_TOKENS, dripAmount * BigInt(dailyMaxClaims));
    if (dailyMaxTokens < dripAmount) {
      throw new AppError(500, "FAUCET_DAILY_MAX_TOKENS must be at least FAUCET_DRIP_AMOUNT");
    }

    this.config = {
      mongodbUrl: envs.MONGO_DB_URL ?? "",
      ckbRpcUrl: envs.CKB_RPC_URL ?? "",
      ckbNetwork: parseCkbNetwork(envs.CKB_NETWORK),
      port: Number(envs.PORT ?? 3100),
      issuerPrivateKey,
      dripAmount,
      cooldownHours: parsePositiveInteger("FAUCET_COOLDOWN_HOURS", envs.FAUCET_COOLDOWN_HOURS, 24),
      dailyMaxClaims,
      dailyMaxTokens,
    };

    if (this.config.mongodbUrl === "" || this.config.ckbRpcUrl === "") {
      throw new AppError(500, "Some environment variables are missing");
    }

    return this.config;
  }
}
