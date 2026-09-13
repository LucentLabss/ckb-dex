import mongoose from "mongoose";
import AppError from "./error.js";

export class Database {
  constructor(readonly mongodbUrl: string) {}

  public async connect(): Promise<void> {
    await mongoose.connect(this.mongodbUrl).catch((err) => {
      console.error(err);
      throw new AppError(500, "Unable to connect to the faucet database");
    });
    console.log("Connected to faucet DB successfully");
  }

  public isConnected(): boolean {
    return mongoose.connection.readyState === 1;
  }

  public async disconnect(): Promise<void> {
    await mongoose.disconnect();
  }
}
