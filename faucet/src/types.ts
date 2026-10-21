export type Hex = `0x${string}`;

/** Which bucket of deployment/system-scripts.json to read. */
export type CkbNetwork = "devnet" | "testnet" | "mainnet";

export interface Config {
  mongodbUrl: string;
  ckbRpcUrl: string;
  ckbNetwork: CkbNetwork;
  port: number;
  issuerPrivateKey: Hex;
  /** Raw xUDT amount (token base units, no decimal scaling) sent per successful claim. */
  dripAmount: bigint;
  /** Minimum time a single recipient lock must wait between successful claims. */
  cooldownHours: number;
}

export interface AppApiResponse<T> {
  message: string;
  status: number;
  data: T;
}
