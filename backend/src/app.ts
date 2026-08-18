import bodyParser from "body-parser";
import express, { Request, Response } from "express";
import helmet from "helmet";
import cors from "cors";
import { Config } from "./types";
import { sendSucess } from "./utils";
import router from "./routes";

const app = express();


export function createExpressServer(config: Config) {

    const apiVersion = `/api/v${config?.apiVersion}`;
    /** Middlewares */
    app.use(bodyParser.json());
    app.use(helmet());
    app.use(cors());

    app.get(apiVersion, (req: Request, res: Response) => {
        sendSucess(res, `Welcome to our ckb orderbook dex API: v${config?.apiVersion}`, {})
    })

    app.get(`${apiVersion}/health`, (req: Request, res: Response) => {
        sendSucess(res, `✅ Healthy: ${Date.now()}`, {})
    })

    app.use(`${apiVersion}/order-book`, router)

    return app; 
}