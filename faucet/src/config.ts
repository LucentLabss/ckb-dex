import * as dotenv from "dotenv";
import AppError from "./services/error.js";
import { CkbNetwork, Config, Hex } from "./types.js";

dotenv.config();

const VALID_CKB_NETWORKS: CkbNetwork[] = ["devnet", "testnet", "mainnet"];

function parseCkbNetwork(value: string | undefined): CkbNetwork {
  if (value == undefined || value.trim() === "") {
    return "devnet";
  }
  if (!VALID_CKB_NETWORKS.includes(value as CkbNetwork)) {
    throw new AppError(500, `Invalid CKB_NETWORK "${value}" (expected devnet, testnet or mainnet)`);
  }
  return value as CkbNetwork;
}

export default class AppConfiguration {
  config: Config | undefined;

  async getEnvironment(): Promise<Config> {
    const envs = process.env;

    const issuerPrivateKey = envs.FAUCET_ISSUER_PRIVATE_KEY as Hex | undefined;
    if (!issuerPrivateKey) {
      throw new AppError(500, "FAUCET_ISSUER_PRIVATE_KEY is missing from the environment");
    }

    this.config = {
      mongodbUrl: envs.MONGO_DB_URL ?? "",
      ckbRpcUrl: envs.CKB_RPC_URL ?? "",
      ckbNetwork: parseCkbNetwork(envs.CKB_NETWORK),
      port: Number(envs.PORT ?? 3100),
      issuerPrivateKey,
      dripAmount: BigInt(envs.FAUCET_DRIP_AMOUNT ?? "100"),
      cooldownHours: Number(envs.FAUCET_COOLDOWN_HOURS ?? 24),
    };

    if (this.config.mongodbUrl === "" || this.config.ckbRpcUrl === "") {
      throw new AppError(500, "Some environment variables are missing");
    }

    return this.config;
  }
}
