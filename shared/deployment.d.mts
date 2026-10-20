export type Hex = `0x${string}`;
export type HashType = "data" | "type" | "data1" | "data2";
export interface ScriptIdentity { codeHash: Hex; hashType: HashType; }
export interface AssetType extends ScriptIdentity { args: Hex; }
export interface CellDep {
  outPoint: { txHash: Hex; index: number };
  depType: "code" | "depGroup";
}
export interface DeploymentScript extends ScriptIdentity { cellDeps: { cellDep: CellDep }[]; }
export interface Deployment {
  network: "devnet" | "testnet" | "mainnet";
  genesisHash: Hex;
  client: "testnet" | "mainnet";
  dex: DeploymentScript;
  knownScripts: Record<string, DeploymentScript>;
  assets: { id: string; symbol: string; args: Hex }[];
}
export function getDeployment(network: string): Deployment;
export function getAssetType(deployment: Deployment, id?: string): AssetType;
export function assertDexConfiguration(deployment: Deployment, configured: AssetType): void;
export function assertSupportedAsset(
  ccc: { Script: { from(type: AssetType): { hash(): string } } },
  deployment: Deployment, type: AssetType,
): void;
export function createDeploymentClient<T extends {
  ClientPublicTestnet: new (...args: any[]) => any;
  ClientPublicMainnet: new (...args: any[]) => any;
}>(ccc: T, deployment: Deployment, url: string):
  InstanceType<T["ClientPublicTestnet"]> | InstanceType<T["ClientPublicMainnet"]>;
export function verifyDeployment(
  ccc: { hashCkb(data: Hex): string },
  client: {
    getHeaderByNumberNoCache(number: number): Promise<{ hash: string } | undefined>;
    getCellLive(outPoint: CellDep["outPoint"], withData: boolean): Promise<{
      cellOutput: { type?: { hash(): string } | null };
      outputData: Hex;
    } | undefined>;
  },
  deployment: Deployment,
): Promise<void>;
