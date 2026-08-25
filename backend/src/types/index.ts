// Re-exports shared backend type definitions.
export * from "./db.js";
export * from "./config.js";
export interface AppApiResponse<T> {
    message: string;
    status: number;
    data: T,
}