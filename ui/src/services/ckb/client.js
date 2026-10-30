import { ccc } from "@ckb-ccc/connector-react";
import { CKB_RPC_URL } from "../../config/env.js";
// The same deployment manifest the backend, faucet and offchain scripts use
// (vite.config.js lets the dev server read it from the repo root).
import {
  createDeploymentClient,
  getAssetType,
  getDeployment,
  verifyDeployment,
} from "../../../../shared/deployment.mjs";

export const deployment = getDeployment("testnet");
export const NETWORK_LABEL = deployment.network.toUpperCase();

/**
 * The CKB client every signer and query uses. Every script the manifest
 * declares is pinned and there are no fallback RPCs, so it can't silently
 * drift to another chain.
 */
export const ckbClient = createDeploymentClient(ccc, deployment, CKB_RPC_URL);

let verified = null;

/**
 * Checks the RPC is on the manifest's chain and the DEX and xUDT code cells
 * are live. Runs once per session; a failure is retried on the next call.
 */
export function verifyChain() {
  verified ??= verifyDeployment(ccc, ckbClient, deployment).catch((err) => {
    verified = null;
    throw err;
  });
  return verified;
}

const cellDepsOf = (script) => script.cellDeps.map(({ cellDep }) => cellDep);

/** The deployed DEX order lock. */
export const dexScript = {
  codeHash: deployment.dex.codeHash,
  hashType: deployment.dex.hashType,
  cellDeps: cellDepsOf(deployment.dex),
};

/** xUDT code cells from the manifest (pinned, not looked up). */
export const xudtCellDeps = cellDepsOf(deployment.knownScripts.XUdt);

/** The manifest's market token (the "demo" asset). */
export const marketAsset = deployment.assets.find((a) => a.id === "demo") ?? deployment.assets[0];
export const marketTokenType = ccc.Script.from(getAssetType(deployment, marketAsset.id));
