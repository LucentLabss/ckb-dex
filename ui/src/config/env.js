/**
 * Runtime configuration, read once from Vite env vars (see .env.example).
 * The dapp runs on CKB testnet; contracts and the market token come from the
 * shared deployment manifest (ckb-dex/deployment/manifest.json).
 *
 * Defaults point at the deployed ckb-dex backend and faucet, so the UI works
 * without a .env.local. Set the VITE_* vars to use other instances (e.g. a
 * local backend); an empty value counts as unset.
 */
const env = import.meta.env;

const DEPLOYED_API_ORIGIN = "https://api.72.62.119.247.sslip.io";
const DEPLOYED_FAUCET_URL = "https://faucet.72.62.119.247.sslip.io/api/v1/faucet";

export const API_URL = env.VITE_API_URL || `${DEPLOYED_API_ORIGIN}/api/v1`;
/** Realtime runs on the backend's HTTP server, so it defaults to the API's origin. */
export const WS_URL =
  env.VITE_WS_URL || API_URL.replace(/^http/, "ws").replace(/\/api\/v\d+\/?$/, "");

/** Public testnet RPC by default; the browser talks to it directly (it allows CORS). */
export const CKB_RPC_URL = env.VITE_CKB_RPC_URL || "https://testnet.ckb.dev";

/** xUDT faucet service (ckb-dex/faucet) behind the "Get TOKEN" button. */
export const FAUCET_URL = env.VITE_FAUCET_URL || DEPLOYED_FAUCET_URL;

/** The manifest has no decimals for the demo token; whole units unless set. */
export const XUDT_DECIMALS = Number(env.VITE_XUDT_DECIMALS || 0);
