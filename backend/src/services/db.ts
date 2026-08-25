// Manages the backend's MongoDB connection lifecycle.
import mongoose from "mongoose";
import { DatabaseType } from "../types";
import AppError from "./error.js";

export class Database implements DatabaseType {
    constructor(readonly mongodb_url: string) {
        this.mongodb_url = mongodb_url;
    }

    public async connect() {
        try {
            await mongoose.connect(this.mongodb_url);
            console.log("Connected to DB successfully");
        } catch (error) {
            console.error(error);
            throw(new AppError(500, "Internal server database error"));
        }
    };

    public async disconnect() {
        await mongoose.disconnect();
    };

    public isConnected() {
        return mongoose.connection.readyState === 1;
    };
}