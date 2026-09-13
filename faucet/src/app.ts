import bodyParser from "body-parser";
import express, { Request, Response } from "express";
import helmet from "helmet";
import cors from "cors";
import createRouter from "./routes/index.js";
import TokenFaucet from "./services/faucet.js";

export function createExpressServer(faucet: TokenFaucet) {
  const app = express();

  app.use(bodyParser.json());
  app.use(helmet());
  app.use(cors());

  app.get("/", (_req: Request, res: Response) => {
    res.status(200).send("Faucet reachable");
  });

  app.use("/api/v1/faucet", createRouter(faucet));

  return app;
}
