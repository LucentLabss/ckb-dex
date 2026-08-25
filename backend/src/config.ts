// Loads, validates, and supplies runtime configuration for the backend service.
import AppError from "./services/error.js";
import { Config, AppConfig, NODE_ENV, Hex, HashType } from "./types";
import * as dotenv from "dotenv";

dotenv.config();

const VALID_HASH_TYPES: HashType[] = ["data", "type", "data1", "data2"];
const DEFAULT_CONFIG = {
    mongodbUrl: "mongodb://127.0.0.1:27017/ckb-dex",
    ckbRpcUrl: "http://127.0.0.1:8114",
    internalBotToken: "dev-internal-bot-token",
    port: 3000,
    apiVersion: 1,
    enviroment: "development" as const,
    dexScriptCodeHash: `0x${"11".repeat(32)}` as Hex,
    dexScriptHashType: "type" as const,
    dexScriptArgs: "0x" as Hex,
};

function requireEnv(name: string, value: string | undefined, fallback?: string): string {
    if (value == undefined || value.trim() === "") {
        if (fallback !== undefined) {
            return fallback;
        }

        throw new AppError(500, `Missing required environment variable: ${name}`);
    }

    return value;
}

function parseInteger(name: string, value: string | undefined, fallback?: number): number {
    if (value == undefined || value.trim() === "") {
        if (fallback !== undefined) {
            return fallback;
        }

        throw new AppError(500, `Invalid integer value for ${name}`);
    }

    const parsed = Number(value);

    if (!Number.isInteger(parsed) || parsed <= 0) {
        if (fallback !== undefined) {
            return fallback;
        }

        throw new AppError(500, `Invalid integer value for ${name}`);
    }

    return parsed;
}

function parseNodeEnv(value: string | undefined): NODE_ENV {
    if (value === "production" || value === "development") {
        return value;
    }

    return DEFAULT_CONFIG.enviroment;
}

function parseHashType(name: string, value: string | undefined): HashType {
    const parsedValue = requireEnv(name, value, DEFAULT_CONFIG.dexScriptHashType);

    if (!VALID_HASH_TYPES.includes(parsedValue as HashType)) {
        throw new AppError(500, `Invalid hash type for ${name}`);
    }

    return parsedValue as HashType;
}

export default class AppConfiguration implements AppConfig {
    config: Config | undefined;
    constructor() {
        this.config = undefined;
    }

    async getEnvironment(): Promise<Config> {
        const envs = process.env;
        if (envs == undefined) {
            throw (new AppError(500, "Unable to access OS environment variables"));
        }

        const dexScriptCodeHash = envs.CKB_DEX_SCRIPT_CODE_HASH ?? envs.CKD_DEX_SCRIPT_CODE_HASH ?? DEFAULT_CONFIG.dexScriptCodeHash;

        this.config = {
            mongodbUrl: requireEnv("MONGO_DB_URL", envs.MONGO_DB_URL, DEFAULT_CONFIG.mongodbUrl),
            dexOrderLockScript: {
                codeHash: requireEnv("CKB_DEX_SCRIPT_CODE_HASH", dexScriptCodeHash, DEFAULT_CONFIG.dexScriptCodeHash) as Hex,
                hashType: parseHashType("CKB_DEX_SCRIPT_HASH_TYPE", envs.CKB_DEX_SCRIPT_HASH_TYPE),
                args: requireEnv("CKB_DEX_SCRIPT_ARGS", envs.CKB_DEX_SCRIPT_ARGS, DEFAULT_CONFIG.dexScriptArgs) as Hex,
            },
            enviroment: parseNodeEnv(envs.NODE_ENV),
            port: parseInteger("PORT", envs.PORT, DEFAULT_CONFIG.port),
            ckbRpcUrl: requireEnv("CKB_RPC_URL", envs.CKB_RPC_URL, DEFAULT_CONFIG.ckbRpcUrl),
            internalBotToken: requireEnv("INTERNAL_BOT_TOKEN", envs.INTERNAL_BOT_TOKEN, DEFAULT_CONFIG.internalBotToken),
            apiVersion: parseInteger("API_VERSION", envs.API_VERSION, DEFAULT_CONFIG.apiVersion),
        };

        return this.config;
    }
}

