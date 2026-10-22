// Atomic claim and budget accounting: every check-and-reserve is a single database operation,
// so concurrent requests cannot both pass a cooldown or overshoot a global budget.
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import FaucetClaim from "../models/claim.js";
import FaucetBudget from "../models/budget.js";
import AppError from "./error.js";

export interface ClaimLimits {
  cooldownMs: number;
  /** A RESERVED claim older than this is assumed abandoned (e.g. a crash) and may be retaken. */
  reservationTimeoutMs: number;
  dripAmount: bigint;
  dailyMaxClaims: number;
  dailyMaxTokens: bigint;
}

export interface Reservation {
  lockHash: string;
  reservationId: string;
  day: string;
  /** Whether a claim document existed before this reservation (and so must be restored, not deleted). */
  hadPrevious: boolean;
  previousStatus: string | undefined;
}

const isDuplicateKey = (error: unknown) =>
  typeof error === "object" && error !== null && (error as { code?: number }).code === 11000;

const decimal = (value: bigint) => mongoose.Types.Decimal128.fromString(value.toString());
const dayKey = (now: Date) => now.toISOString().slice(0, 10);

export default class ClaimStore {
  constructor(readonly limits: ClaimLimits) {
    if (limits.dailyMaxTokens < limits.dripAmount) {
      throw new Error("The daily token budget is smaller than a single drip");
    }
  }

  /**
   * Reserves one drip for `lockHash`: checks the per-recipient cooldown, then the global daily
   * budget. A caller still inside its cooldown never consumes any global budget.
   */
  async reserve(lockHash: string, address: string, now: Date = new Date()): Promise<Reservation> {
    const reservationId = randomUUID();
    const cutoff = new Date(now.getTime() - this.limits.cooldownMs);
    const stale = new Date(now.getTime() - this.limits.reservationTimeoutMs);

    let previous;
    try {
      previous = await FaucetClaim.findOneAndUpdate(
        {
          _id: lockHash,
          $or: [
            // Completed claim (or a legacy document with no status) that has cooled down.
            { status: { $ne: "RESERVED" }, lastClaimedAt: { $not: { $gt: cutoff } } },
            // Abandoned reservation.
            { status: "RESERVED", reservedAt: { $lte: stale } },
          ],
        },
        { $set: { address, status: "RESERVED", reservedAt: now, reservationId } },
        { upsert: true, returnDocument: "before" },
      );
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
      // The document exists but did not match: a recent claim or one in progress.
      throw await this.rejection(lockHash, now);
    }

    const reservation: Reservation = {
      lockHash,
      reservationId,
      day: dayKey(now),
      hadPrevious: previous !== null,
      previousStatus: previous?.status ?? undefined,
    };

    try {
      await this.takeBudget(reservation.day);
    } catch (error) {
      await this.restoreClaim(reservation);
      throw error;
    }

    return reservation;
  }

  /** Marks the claim as sent. Call once the transaction has been broadcast. */
  async commit(reservation: Reservation, txHash: string, now: Date = new Date()): Promise<void> {
    await FaucetClaim.updateOne(
      { _id: reservation.lockHash, reservationId: reservation.reservationId },
      {
        $set: { status: "SENT", lastClaimedAt: now, lastTxHash: txHash },
        $unset: { reservedAt: "", reservationId: "" },
        $inc: { claimCount: 1 },
      },
    );
  }

  /** Undoes a reservation whose transaction was not sent: frees the recipient and the budget. */
  async release(reservation: Reservation): Promise<void> {
    await this.restoreClaim(reservation);
    await FaucetBudget.updateOne(
      { _id: reservation.day },
      { $inc: { claims: -1, tokens: decimal(-this.limits.dripAmount) } },
    );
  }

  /** Claims and tokens handed out so far today, for health reporting. */
  async usage(now: Date = new Date()): Promise<{ claims: number; tokens: bigint }> {
    const doc = await FaucetBudget.findById(dayKey(now)).lean();
    return { claims: doc?.claims ?? 0, tokens: BigInt(doc?.tokens?.toString() ?? "0") };
  }

  private async takeBudget(day: string): Promise<void> {
    const { dripAmount, dailyMaxClaims, dailyMaxTokens } = this.limits;
    try {
      await FaucetBudget.findOneAndUpdate(
        {
          _id: day,
          claims: { $lt: dailyMaxClaims },
          tokens: { $lte: decimal(dailyMaxTokens - dripAmount) },
        },
        { $inc: { claims: 1, tokens: decimal(dripAmount) } },
        { upsert: true, returnDocument: "after" },
      );
    } catch (error) {
      // Day document exists but the guard failed, so the insert collided: budget is spent.
      if (isDuplicateKey(error)) {
        throw new AppError(503, "The faucet has reached its daily limit - please try again tomorrow");
      }
      throw error;
    }
  }

  private async restoreClaim(reservation: Reservation): Promise<void> {
    const mine = { _id: reservation.lockHash, reservationId: reservation.reservationId };
    if (!reservation.hadPrevious) {
      await FaucetClaim.deleteOne(mine);
      return;
    }
    await FaucetClaim.updateOne(mine, {
      $set: { status: reservation.previousStatus ?? "SENT" },
      $unset: { reservedAt: "", reservationId: "" },
    });
  }

  private async rejection(lockHash: string, now: Date): Promise<AppError> {
    const existing = await FaucetClaim.findById(lockHash).lean();
    if (existing?.status === "RESERVED") {
      return new AppError(409, "A claim for this address is already in progress");
    }
    const claimedAt = existing?.lastClaimedAt?.getTime() ?? now.getTime();
    const retryAfterSeconds = Math.max(1, Math.ceil((claimedAt + this.limits.cooldownMs - now.getTime()) / 1000));
    return new AppError(429, `This address already claimed - try again in ${retryAfterSeconds}s`);
  }
}
