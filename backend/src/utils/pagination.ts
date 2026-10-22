// Opaque keyset cursors so list endpoints page in the database instead of loading whole collections.
import { z } from "zod";
import AppError from "../services/error.js";

export const MAX_PAGE_SIZE = 200;
export const DEFAULT_PAGE_SIZE = 25;
export const MAX_CURSOR_LENGTH = 512;

export const limitSchema = z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE);
export const cursorSchema = z.string().max(MAX_CURSOR_LENGTH).optional();

export function encodeCursor(payload: Record<string, string | number>): string {
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

export function decodeCursor<T extends z.ZodTypeAny>(cursor: string | undefined, shape: T): z.infer<T> | undefined {
  if (cursor === undefined) return undefined;
  try {
    return shape.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
  } catch {
    throw new AppError(400, "Invalid cursor");
  }
}
