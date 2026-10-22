import bodyParser from "body-parser";
import express, { NextFunction, Request, Response } from "express";
import helmet from "helmet";
import cors from "cors";
import createRouter from "./routes/index.js";
import TokenFaucet from "./services/faucet.js";
import { sendError } from "./utils/shared.js";

export function createExpressServer(faucet: TokenFaucet) {
  const app = express();

  app.use(bodyParser.json({ limit: "4kb" }));
  app.use(helmet());
  app.use(cors());

  app.get("/", (_req: Request, res: Response) => {
    res.status(200).send("Faucet reachable");
  });

  app.use("/api/v1/faucet", createRouter(faucet));

  // Malformed or oversized bodies are client errors, reported as JSON like every other response.
  app.use((error: { status?: number }, _req: Request, res: Response, _next: NextFunction) => {
    const status = error.status !== undefined && error.status >= 400 && error.status < 500 ? error.status : 500;
    sendError(res, status === 413 ? "Request body too large" : status === 500 ? "Internal server error" : "Malformed request", null, status);
  });

  return app;
}
