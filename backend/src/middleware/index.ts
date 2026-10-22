// Provides request context, internal bot authentication, and centralized API error middleware.
import { NextFunction, Request, Response } from "express";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import AppError from "../services/error.js";
import { sendError } from "../utils/index.js";
import { Config } from "../types/index.js";

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
