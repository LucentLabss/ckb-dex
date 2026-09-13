import { Response } from "express";
import { AppApiResponse } from "../types.js";

export function sendSuccess<T>(
  res: Response,
  message: string = "Success",
  data: T,
  status: number = 200,
) {
  return res.status(status).send({ message, data, status } as AppApiResponse<T>);
}

export function sendError<T>(
  res: Response,
  message: string = "Error",
  data: T | null = null,
  status: number = 500,
) {
  return res.status(status).send({ message, data, status } as AppApiResponse<T>);
}
