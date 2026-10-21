// Declares the strongly typed runtime configuration and CKB script shapes used by the backend.
export type Hex = `0x${string}`;

export type HashType = "data" | "type" | "data1" | "data2"

export interface Script {
  codeHash: Hex;
  args: Hex;
  hashType: HashType;
}

export enum OrderType {"ASK", "BID"}

export type NODE_ENV = "production" | "development";

/** Which bucket of deployment/scripts.json and deployment/system-scripts.json to read. */
export type CkbNetwork = "devnet" | "testnet" | "mainnet";

export interface Config {
  mongodbUrl: string;
  ckbRpcUrl: string,
  ckbNetwork: CkbNetwork,
  enviroment: NODE_ENV,
  dexOrderLockScript: Script,
  internalBotToken: string,
  port: number,
  apiVersion: number
}

export interface AppConfig {
  config: Config | undefined;
  getEnvironment: () => Promise<Config>;
}
export interface DexLockArgs {
  ownerLock: Script;
  orderType: OrderType;
  pricePerToken: bigint;
}
