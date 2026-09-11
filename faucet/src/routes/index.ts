import express, { Request, Response } from "express";
import TokenFaucet from "../services/faucet.js";
import AppError from "../services/error.js";
import { sendError, sendSuccess } from "../utils/shared.js";

// Lightweight in-memory per-IP throttle, on top of the DB-backed per-address cooldown in
// TokenFaucet.claim - stops one caller from burning through the issuer's CKB balance in
// fees by hammering the endpoint with many different addresses. Resets on restart; the
// persisted per-address cooldown is the real guarantee, this is just abuse mitigation.
const MIN_MS_BETWEEN_REQUESTS_PER_IP = 5_000;
const lastRequestAtByIp = new Map<string, number>();

function throttleByIp(req: Request, res: Response, next: () => void) {
  const ip = req.ip ?? "unknown";
  const last = lastRequestAtByIp.get(ip);
  const now = Date.now();
  if (last !== undefined && now - last < MIN_MS_BETWEEN_REQUESTS_PER_IP) {
    return sendError(res, "Too many requests, please slow down", null, 429);
  }
  lastRequestAtByIp.set(ip, now);
  next();
}

export default function createRouter(faucet: TokenFaucet) {
  const router = express.Router();

  router.get("/health", (_req: Request, res: Response) => {
    sendSuccess(res, "Faucet is healthy", { drip: faucet.config.dripAmount.toString() });
  });

  router.post("/claim", throttleByIp, async (req: Request, res: Response) => {
    const address = req.body?.address;
    if (typeof address !== "string" || address.length === 0) {
      return sendError(res, "Body must include a non-empty `address` string", null, 400);
    }

    try {
      const txHash = await faucet.claim(address);
      sendSuccess(res, "Claim submitted", {
        txHash,
        amount: faucet.config.dripAmount.toString(),
      });
    } catch (err) {
      if (err instanceof AppError) {
        return sendError(res, err.message, null, err.statusCode);
      }
      console.error("Faucet claim failed:", err);
      sendError(res, "Failed to process claim", null, 500);
    }
  });

  return router;
}
