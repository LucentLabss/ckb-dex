// Builds the Express API application, including health, market, and authenticated bot-ingestion routes.
import bodyParser from "body-parser";
import express, { Request, Response } from "express";
import helmet from "helmet";
import cors from "cors";
import { Config } from "./types";
import { sendSuccess } from "./utils";
import marketRouter from "./routes/market.js";
import internalRouter from "./routes/internal";
import { createInternalBotAuthMiddleware, errorHandler, requestContextMiddleware } from "./middleware";
import { RealtimeBroadcaster } from "./services/realtime.js";

interface CreateExpressServerOptions {
    isReady: () => boolean;
}

export function createExpressServer(config: Config, options: CreateExpressServerOptions) {
    const app = express();

    const apiVersion = `/api/v${config?.apiVersion}`;
    /** Middlewares */
    app.use(requestContextMiddleware);
    app.use(bodyParser.json());
    app.use(helmet());
    app.use(cors());

    app.get(apiVersion, (_req: Request, res: Response) => {
        sendSuccess(res, `Welcome to our ckb orderbook dex API: v${config?.apiVersion}`, {
            service: "backend",
            requestId: res.locals.requestId,
        })
    })

    app.get(`${apiVersion}/health`, (_req: Request, res: Response) => {
        sendSuccess(res, `Healthy: ${Date.now()}`, {
            requestId: res.locals.requestId,
            status: "ok",
        })
    })

    app.get(`${apiVersion}/readiness`, (_req: Request, res: Response) => {
        const isReady = options.isReady();

        if (!isReady) {
            return res.status(503).send({
                message: "Service not ready",
                data: { requestId: res.locals.requestId, status: "degraded" },
                status: 503,
            });
        }

        return sendSuccess(res, "Service ready", {
            requestId: res.locals.requestId,
            status: "ready",
        });
    });

    app.use(`${apiVersion}`, marketRouter);
    app.use(
        `${apiVersion}/internal`,
        createInternalBotAuthMiddleware(config),
        internalRouter,
    );
    app.use(errorHandler);

    const realtime = RealtimeBroadcaster.getInstance();
    app.locals.realtime = realtime;

    return app; 
}