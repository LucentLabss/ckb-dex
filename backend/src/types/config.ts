export interface Script {
    codeHash: string;
    args: string;
    hashType: string;
}
export type NODE_ENV = "production" | "development";

export interface Config {
    mongodbUrl: string;
    ckbRpcUrl: string,
    enviroment: NODE_ENV,
    dexOrderLockScript: Script,
    port: number,
    apiVersion: number
}

export interface AppConfig {
    config: Config | undefined;
    getEnvironment: () => Promise<Config>;
}
