// Manages the backend's MongoDB connection lifecycle.
import mongoose from "mongoose";
import { DatabaseType } from "../types";
import AppError from "./error.js";

export class Database implements DatabaseType {
  constructor(readonly mongodb_url: string) {
    this.mongodb_url = mongodb_url;
  }

  public async connect() {
    // Without this, queries issued while disconnected (e.g. demo mode below, or a dropped
    // connection) hang forever waiting for a connection instead of rejecting - which would
    // otherwise turn every API request into a request that never resolves.
    mongoose.set("bufferCommands", false);

    try {
      await mongoose.connect(this.mongodb_url);
      console.log("Connected to DB successfully");
    } catch (error) {
      console.warn(
        "Database connection failed:",
        error instanceof Error ? error.message : error,
      );
      console.warn("Starting in demo mode without database persistence");
    }
  }

  public async disconnect() {
    await mongoose.disconnect();
  }

  public isConnected() {
    return mongoose.connection.readyState === 1;
  }
}
