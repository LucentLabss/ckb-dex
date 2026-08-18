import mongoose, { Schema } from "mongoose";
import { type Script as LockScript } from "../types";

export const Script = new Schema({
    codeHash: String,
    hashType: String,
    /**@property args is the molecule serialized owner's lockscript which can be deserialized */
    args: String /** The full "0x2c0000..." blob */
})

export interface OrderDocument {
    _id: number;
    outPoint: { txHash: string; index: number };
    lockScript: LockScript;
    /* Parsed for fast querying */
    ownerAddress: string;
    orderType: "LIMIT" | "MARKET";
    price: string;
    amount: string;
    tokenPair: string;
    direction: "BUY" | "SELL"
    status: "LIVE" | "FILLED" | "CANCELED";
}

export const OutPointType = new Schema({
    txHash: String,
    index: Number
});


export const OrderSchema = new Schema<OrderDocument>({
    _id: Number,
    outPoint: {
        type: OutPointType,
        required: true
    },
    lockScript: {
        type: Script,
        required: true
    },
    ownerAddress: {
        type: String,
        required: true
    },
    orderType: {
        type: String,
        enum: ["LIMIT", "MARKET"]
    },
    status: {
        type: String,
        enum: ["LIVE", "FILLED", "CANCELD"],
        required: true
    },
    price: {
        type: String,
        required: true
    },
    amount: {
        type: String,
        required: true
    },
    tokenPair: {
        type: String,
        required: true
    },
    direction: {
        type: String,
        enum: ["BUY", "SELL"]
    },
})


const OrderModel = mongoose.model("Order", OrderSchema);
export default OrderModel;