// Provides shared API response helpers and CKB-oriented value conversion utilities.
import { Response } from "express";
import { AppApiResponse, DexLockArgs, HashType, Hex, OrderType, Script } from "../types";
import AppError from "../services/error.js";
import { numToBytes } from "@ckb-ccc/core";

export const extractNestedValues = (obj: any): string[] => Object.values(obj).flatMap(value => typeof value === "object" && value !== null ? extractNestedValues(value) : String(value))

export function sendSucess<T>(
  res: Response,
  message: string = "Sucess",
  data: T,
  status: number = 200
) {
  return res.status(status).send({
    message,
    data,
    status
  } as AppApiResponse<T>)
}

export const sendSuccess = sendSucess;

export function sendError<T>(
  res: Response,
  message: string = "Error",
  data: T | null = null,
  status: number = 500
) {
  return res.status(status).send({
    message,
    data,
    status
  } as AppApiResponse<T>)
}


const HEX_STRING_PATTERN = /^0x(?:[0-9a-fA-F]{2})*$/;

export function toBuffer(hex: Hex){
  if(typeof hex != "string" || !HEX_STRING_PATTERN.test(hex)){
    throw new AppError(400, `not a valid 0x-prefixed even-length hex string: ${hex}`);
  }

  return Buffer.from(hex.slice(2), "hex");
}

export const toHex = (b: Buffer | Uint8Array): Hex =>
  `0x${Buffer.from(b).toString("hex")}`;

const HASH_TYPE_TO_BYTE: Record<HashType, number> = {
  data: 0,
  type: 1,
  data1: 2,
  data2: 4,
};
 
const BYTE_TO_HASH_TYPE: Record<number, HashType> = {
  0: "data",
  1: "type",
  2: "data1",
  4: "data2",
};

export const byteLength = (hex: Hex): number => (hex.length - 2) / 2;

export function encodeScript(s: Script): Buffer {
  if (byteLength(s.codeHash) !== 32)
    throw new Error(`codeHash must be 32 bytes, got ${byteLength(s.codeHash)}`);
  const ht = HASH_TYPE_TO_BYTE[s.hashType];
  if (ht === undefined) throw new Error(`unknown hashType "${s.hashType}"`);
 
  const args = toBuffer(s.args);
  const out = Buffer.alloc(53 + args.length);
  out.writeUInt32LE(out.length, 0);
  out.writeUInt32LE(16, 4);
  out.writeUInt32LE(48, 8);
  out.writeUInt32LE(49, 12);
  toBuffer(s.codeHash).copy(out, 16);
  out.writeUInt8(ht, 48);
  out.writeUInt32LE(args.length, 49);
  args.copy(out, 53);
  return out;
}

/** Decode a Script at `offset`. Returns the script and where it ends. */
export function decodeScript(
  buf: Buffer,
  offset = 0,
): { script: Script; end: number } {
  if (buf.length < offset + 53)
    throw new Error(`script truncated at offset ${offset}`);
 
  const full = buf.readUInt32LE(offset);
  if (full < 53 || offset + full > buf.length)
    throw new Error(`script full_size ${full} overruns the buffer`);
 
  const hashType = BYTE_TO_HASH_TYPE[buf.readUInt8(offset + 48)];
  if (hashType === undefined)
    throw new Error(
      `unknown hash_type byte 0x${buf.readUInt8(offset + 48).toString(16)}`,
    );
 
  const argsLen = buf.readUInt32LE(offset + 49);
  if (53 + argsLen !== full)
    throw new Error(
      `script args length ${argsLen} disagrees with full_size ${full}`,
    );
 
  return {
    script: {
      // Buffer.subarray is a zero-copy VIEW over the same memory. toHex copies
      // it into a string, so nothing escapes holding a reference to `buf`.
      codeHash: toHex(buf.subarray(offset + 16, offset + 48)),
      hashType,
      args: toHex(buf.subarray(offset + 53, offset + full)),
    },
    end: offset + full,
  };
}


const MAX_U64 = 0xffff_ffff_ffff_ffffn;

export function encodeDexLockScriptArgs(a: DexLockArgs): Hex {
  if (typeof a.pricePerToken !== "bigint")
    throw new Error("pricePerToken must be a bigint");
  if (a.pricePerToken <= 0n) throw new Error("price must be positive");
  if (a.pricePerToken > MAX_U64) throw new Error("price exceeds u64");
  if (a.orderType !== OrderType.ASK && a.orderType !== OrderType.BID)
    throw new Error(`unknown order type ${a.orderType}`);
 
  const lock = encodeScript(a.ownerLock);
  const out = Buffer.alloc(lock.length + 9);
  lock.copy(out, 0);
  out.writeUInt8(a.orderType, lock.length);
  out.writeBigUInt64LE(a.pricePerToken, lock.length + 1);
  return toHex(out);
}
 
export function decodeDexLockScriptArgs(hex: Hex): DexLockArgs {
  const buf = toBuffer(hex);
  const { script: ownerLock, end } = decodeScript(buf, 0);
 
  // Strict total-length check. Without it, args carrying trailing garbage
  // decode "successfully" into a plausible order at the wrong price, and you
  // find out when the contract rejects your settlement with an exit code.
  if (buf.length !== end + 9)
    throw new Error(
      `dex args are ${buf.length} bytes, expected ${end + 9} ` +
        `(script ${end} + type 1 + price 8)`,
    );
 
  const orderType = buf.readUInt8(end);
  if (orderType !== OrderType.ASK && orderType !== OrderType.BID)
    throw new Error(`unknown order type byte ${orderType}`);
 
  return {
    ownerLock,
    orderType,
    pricePerToken: buf.readBigUInt64LE(end + 1),
  };
}
 
/**
 * Prefix for the indexer to find every order made by one owner. Byte-aligned
 * by construction, which prefix search requires.
 *
 *   getCells({ script: { codeHash: DEX_LOCK, hashType: "type",
 *                        args: ownerSearchPrefix(makerLock) },
 *              scriptType: "lock", scriptSearchMode: "prefix" })
 */
export const ownerSearchPrefix = (ownerLock: Script): Hex =>
  toHex(encodeScript(ownerLock));
 
/**
 * Cheap equality for two args blobs. The contract compares whole lock scripts
 * byte-for-byte when validating a continuation cell, so this is the check to
 * run before you build one.
 */
export const sameArgs = (a: Hex, b: Hex): boolean =>
  toBuffer(a).equals(toBuffer(b));
 
