import mongoose from "mongoose";

await mongoose.connect("mongodb://127.0.0.1:27017/?directConnection=true&serverSelectionTimeoutMS=2000&appName=ckd-dex");

const db = mongoose.connection.db;
const orders = db.collection("orders");

const stuck = await orders.findOne({ "outPoint.txHash": "0xc96df5ac0ca92fc0e29c1cdc6b5dcdd90a474f5aa9db46928085319534417490" });
console.log("Stuck order doc:", JSON.stringify(stuck, null, 2));

const allLive = await orders.find({ status: "LIVE" }).toArray();
console.log("\nAll LIVE count:", allLive.length);
for (const o of allLive) {
  console.log(o._id, o.direction, o.pricePerToken, o.remainingAmount, o.status);
}

const allStatuses = await orders.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]).toArray();
console.log("\nStatus breakdown:", allStatuses);

await mongoose.disconnect();
