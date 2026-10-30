import { ccc } from "@ckb-ccc/connector-react";
import { XUDT_DECIMALS } from "../../config/env.js";
import { marketAsset, marketTokenType } from "./client.js";

const token = {
  type: marketTokenType,
  typeHash: marketTokenType.hash(),
  symbol: marketAsset.symbol,
  decimals: XUDT_DECIMALS,
};

/** The xUDT traded on this market, from the deployment manifest. */
export function getMarketToken() {
  return Promise.resolve(token);
}

/** Sum of the token held in the signer's live cells, in base units. */
export async function getTokenBalance(signer, token) {
  let total = 0n;
  for await (const cell of signer.findCells({ script: token.type }, true)) {
    total += ccc.udtBalanceFrom(cell.outputData);
  }
  return total;
}
