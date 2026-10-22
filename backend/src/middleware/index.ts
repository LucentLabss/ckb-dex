// Provides request context, internal bot authentication, and centralized API error middleware.
import { NextFunction, Request, Response } from "express";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import AppError from "../services/error.js";
import { sendError } from "../utils/index.js";
import { Config } from "../types/index.js";
import { ZodError } from "zod";

export function requestContextMiddleware(
	req: Request,
	res: Response,
	next: NextFunction,
) {
	const requestId = req.header("x-request-id") ?? randomUUID();
	res.setHeader("x-request-id", requestId);
	res.locals.requestId = requestId;
	next();
}

export function errorHandler(
	error: Error,
	_req: Request,
	res: Response,
	_next: NextFunction,
) {
	const requestId = res.locals.requestId as string | undefined;

	if (error instanceof AppError) {
		return sendError(res, error.message, { requestId }, error.statusCode);
	}

	// Bad client input is a 4xx, never an "Internal server error".
	if (error instanceof ZodError) {
		const message = error.issues.map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`).join("; ");
		return sendError(res, message, { requestId }, 400);
	}
	const httpStatus = (error as { status?: number; type?: string }).status;
	if (httpStatus !== undefined && httpStatus >= 400 && httpStatus < 500) {
		return sendError(res, httpStatus === 413 ? "Request body too large" : "Malformed request", { requestId }, httpStatus);
	}

	console.error("Unhandled error", { requestId, error });
	return sendError(res, "Internal server error", { requestId }, 500);
}

/** Constant-time comparison; hashing first equalizes lengths so none leaks. */
function tokensMatch(provided: string | undefined, expected: string): boolean {
	if (provided === undefined) return false;
	const digest = (value: string) => createHash("sha256").update(value).digest();
	return timingSafeEqual(digest(provided), digest(expected));
}

export function createInternalBotAuthMiddleware(config: Config) {
	return function internalBotAuthMiddleware(
		req: Request,
		res: Response,
		next: NextFunction,
	) {
		const authHeader = req.header("authorization");
		const internalTokenHeader = req.header("x-internal-bot-token");
		const expectedToken = config.internalBotToken;

		if (!expectedToken) {
			return sendError(res, "Unauthorized internal access", {
				requestId: res.locals.requestId,
			}, 401);
		}

		const bearer = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : undefined;
		const isBearerValid = tokensMatch(bearer, expectedToken);
		const isInternalHeaderValid = tokensMatch(internalTokenHeader, expectedToken);

		if (!isBearerValid && !isInternalHeaderValid) {
			return sendError(res, "Unauthorized internal access", {
				requestId: res.locals.requestId,
			}, 401);
		}

		return next();
	};
}


interface RateLimitOptions {
	windowMs: number;
	max: number;
	/** Upper bound on tracked clients so the map itself cannot be used to exhaust memory. */
	maxClients?: number;
}

/** Fixed-window per-client request limiter for the public read API. */
export function createRateLimiter({ windowMs, max, maxClients = 10_000 }: RateLimitOptions) {
	const windows = new Map<string, { start: number; count: number }>();

	return function rateLimiter(req: Request, res: Response, next: NextFunction) {
		const now = Date.now();
		const key = req.ip ?? req.socket.remoteAddress ?? "unknown";

		let entry = windows.get(key);
		if (!entry || now - entry.start >= windowMs) {
			if (windows.size >= maxClients) {
				for (const [client, state] of windows) {
					if (now - state.start >= windowMs) windows.delete(client);
				}
				// Still full of live windows: shed load rather than grow.
				if (windows.size >= maxClients) {
					return sendError(res, "Too many requests", { requestId: res.locals.requestId }, 429);
				}
			}
			entry = { start: now, count: 0 };
			windows.set(key, entry);
		}

		entry.count += 1;
		const remaining = Math.max(0, max - entry.count);
		res.setHeader("x-ratelimit-limit", String(max));
		res.setHeader("x-ratelimit-remaining", String(remaining));

		if (entry.count > max) {
			res.setHeader("retry-after", String(Math.ceil((entry.start + windowMs - now) / 1000)));
			return sendError(res, "Too many requests", { requestId: res.locals.requestId }, 429);
		}
		return next();
	};
}
