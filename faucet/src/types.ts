export type Hex = `0x${string}`;

/** Which network entry in deployment/manifest.json to use. */
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
  /** Most claims the faucet serves per UTC day across all recipients. */
  dailyMaxClaims: number;
  /** Most raw token units the faucet issues per UTC day across all recipients. */
  dailyMaxTokens: bigint;
}

export interface AppApiResponse<T> {
  message: string;
  status: number;
  data: T;
}
