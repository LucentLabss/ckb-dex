import { Response } from "express";
import { AppApiResponse } from "../types";

export const extractNestedValues = (obj: any): string[] => Object.values(obj).flatMap(value => typeof value === "object" && value !== null ? extractNestedValues(value) : String(value))

export function sendSucess<T>(
    res: Response,
    message: string = "Sucess",
    data: T,
    status: number = 200
){
    return res.status(status).send({
        message,
        data,
        status
    } as AppApiResponse<T>)
}

export function sendError<T>(
    res: Response,
    message: string = "Error",
    data: T | null = null,
    status: number = 500
){
    return res.status(status).send({
        message,
        data,
        status
    } as AppApiResponse<T>)
}