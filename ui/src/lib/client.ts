import { createDexClient, verifyDexClient } from "./dex";

// Local nodes use Vite's CORS proxy; production uses the configured RPC directly.
const rpcUrl = import.meta.env.DEV || !import.meta.env.VITE_CKB_RPC_URL
  ? "/api/ckb-rpc"
  : (import.meta.env.VITE_CKB_RPC_URL as string);

export const ckbClient = createDexClient(rpcUrl);

export async function verifyAppDeployment(): Promise<void> {
  await verifyDexClient(ckbClient);
}
