// Decodes the 90-byte DEX order lock args shared by the bot and the ingestion verifier.
import { ccc } from "@ckb-ccc/core";
import AppError from "../services/error.js";
import { Hex } from "../types/index.js";
import { toBuffer, toHex } from "./shared.js";

/**
 * dex-order-lock args (see smart-contract/contracts/dex-order-lock/src/main.rs):
 *   version(1) + side(1) + makerLockHash(32) + xudtTypeHash(32) + tokenAmount(16, LE) + price(8, LE)
 * The owner lock isn't embedded on-chain - it's recovered from the creating tx's inputs
 * (see findInputWithLockHash), since the lock script never runs at cell creation.
 */
const ORDER_VERSION = 1;
const SIDE_BUY = 0;
const SIDE_SELL = 1;

const HASH_LEN = 32;
const AMOUNT_LEN = 16;
const PRICE_LEN = 8;
const ORDER_ARGS_LEN = 1 + 1 + HASH_LEN + HASH_LEN + AMOUNT_LEN + PRICE_LEN;

export interface DecodedDexOrderArgs {
  makerLockHash: Hex;
  direction: "ASK" | "BID";
  udtTypeHash: Hex;
  tokenAmount: bigint;
  pricePerToken: bigint;
}

export function decodeDexOrderArgs(args: Hex): DecodedDexOrderArgs {
  const buf = toBuffer(args);
  if (buf.length !== ORDER_ARGS_LEN) {
    throw new AppError(
      400,
      `dex order args must be ${ORDER_ARGS_LEN} bytes, got ${buf.length}`,
    );
  }

  const version = buf.readUInt8(0);
  if (version !== ORDER_VERSION) {
    throw new AppError(400, `unsupported dex order args version ${version}`);
  }

  const side = buf.readUInt8(1);
  if (side !== SIDE_BUY && side !== SIDE_SELL) {
    throw new AppError(400, `unknown order side byte ${side}`);
  }

  let offset = 2;
  const makerLockHash = toHex(buf.subarray(offset, offset + HASH_LEN));
  offset += HASH_LEN;
  const udtTypeHash = toHex(buf.subarray(offset, offset + HASH_LEN));
  offset += HASH_LEN;
  const tokenAmount = ccc.numLeFromBytes(toHex(buf.subarray(offset, offset + AMOUNT_LEN)));
  offset += AMOUNT_LEN;
  const pricePerToken = buf.readBigUInt64LE(offset);

  return {
    makerLockHash,
    direction: side === SIDE_SELL ? "ASK" : "BID",
    udtTypeHash,
    tokenAmount,
    pricePerToken,
  };
}
