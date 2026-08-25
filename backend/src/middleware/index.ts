// Provides request context, internal bot authentication, and centralized API error middleware.
import { NextFunction, Request, Response } from "express";
import { randomUUID } from "node:crypto";
import AppError from "../services/error.js";
import { sendError } from "../utils";
import { Config } from "../types";

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

export function createInternalBotAuthMiddleware(config: Config) {
	return function internalBotAuthMiddleware(
		req: Request,
		res: Response,
		next: NextFunction,
	) {
		const authHeader = req.header("authorization");
		const internalTokenHeader = req.header("x-internal-bot-token");
		const expectedToken = config.internalBotToken;

		const isBearerValid = authHeader === `Bearer ${expectedToken}`;
		const isInternalHeaderValid = internalTokenHeader === expectedToken;

		if (!isBearerValid && !isInternalHeaderValid) {
			return sendError(res, "Unauthorized internal access", {
				requestId: res.locals.requestId,
			}, 401);
		}

		return next();
	};
}
