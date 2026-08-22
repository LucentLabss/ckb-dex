import AppError from "./services/error.js";
import { Config, AppConfig, NODE_ENV, Hex, HashType } from "./types";
import * as dotenv from "dotenv";
import { extractNestedValues } from "./utils";

dotenv.config();
export default class AppConfiguration implements AppConfig {
    config: Config | undefined;
    constructor() {
        this.config = undefined;
    }

    async getEnvironment(): Promise<Config> {
        const envs = process.env
        if (envs == undefined) {
            throw (new AppError(500, "Unable to access OS environment variables"));
        }

        this.config = {
            mongodbUrl: envs.MONGO_DB_URL ?? "",
            dexOrderLockScript: {
                codeHash: envs.CKD_DEX_SCRIPT_CODE_HASH as Hex ?? "",
                hashType: envs.CKB_DEX_SCRIPT_HASH_TYPE as HashType ?? "",
                args: envs.CKB_DEX_SCRIPT_ARGS as Hex ?? ""
            },
            enviroment: envs.NODE_ENV as NODE_ENV ?? "development",
            port: Number(envs.PORT) ?? 8080,
            ckbRpcUrl: envs.CKB_RPC_URL ?? "",
            apiVersion: Number(envs.API_VERSION) ?? ""
        }

        const envValues = extractNestedValues(this.config).filter(value => value == "");
        
        if(envValues.length != 0){
            throw (new AppError(500, "Some environment variables are missing"));
        }

        return this.config;
    }
}

