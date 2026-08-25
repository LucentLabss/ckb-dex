// Defines the legacy root API router and its basic welcome response.
import { Router, Request, Response } from "express";
import { sendSuccess } from "../utils";

const router = Router();

router.get("/", (_req: Request, res: Response) => {
    return sendSuccess(res, "Order route reachable", {
        requestId: res.locals.requestId,
    });
})

router.get("/trades", (_req: Request, res: Response) => {
    return sendSuccess(res, "Trades route reachable", {
        requestId: res.locals.requestId,
    });
})

export default router;