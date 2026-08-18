import mongoose from "mongoose";
import { DatabaseType } from "../types";
import AppError from "./error.js";

export class Database implements DatabaseType {
    constructor(readonly mongodb_url: string) {
        this.mongodb_url = mongodb_url;
    }

    public async connect() {
        mongoose.connect(this.mongodb_url)
        .then(() => console.log("Connected to DB successfully"))
        .catch((err) => {
            console.error(err);
            throw(new AppError(500, "Internal server database error"))
        });
    };

    public async disconnect() {
        mongoose.disconnect();
        process.exit(1);
    };
}