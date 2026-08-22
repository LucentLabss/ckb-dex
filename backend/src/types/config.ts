export type Hex = `0x${string}`;

export type HashType = "data" | "type" | "data1" | "data2"

export interface Script {
  codeHash: Hex;
  args: Hex;
  hashType: HashType;
}

export enum OrderType {"ASK", "BID"}

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
export interface DexLockArgs {
  ownerLock: Script;
  orderType: OrderType;
  pricePerToken: bigint;
}
