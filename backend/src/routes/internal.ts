// Accepts authenticated, schema-validated domain events emitted by the chain-indexing bot.
import { Router, Request, Response } from "express";
import AppError from "../services/error.js";
import { EventIngestionService } from "../services";
import { botEventSchema } from "../schemas";
import { sendSuccess } from "../utils";

const router = Router();
const ingestionService = new EventIngestionService();

router.post("/events", async (req: Request, res: Response) => {
  const parsed = botEventSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new AppError(400, parsed.error.issues.map((issue) => issue.message).join("; "));
  }

  const result = await ingestionService.ingest(parsed.data);

  return sendSuccess(res, "Event ingested", {
    requestId: res.locals.requestId,
    result,
  });
});

export default router;