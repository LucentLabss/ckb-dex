import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { ccc } from "@ckb-ccc/core";
import { allocateSettlementCapacity, MAX_SETTLEMENT_FEE } from "../../shared/settlement-capacity.mjs";

const CKB = 100_000_000n;
const price = 500n * CKB;
const sellCapacity = 200n * CKB;
const feeRate = 1_000n;
const buyerLock = ccc.Script.from({
  codeHash: `0x${"11".repeat(32)}`,
  hashType: "type",
  args: `0x${"22".repeat(20)}`,
});
const sellerLock = ccc.Script.from({
  codeHash: `0x${"33".repeat(32)}`,
  hashType: "type",
  args: `0x${"44".repeat(20)}`,
});
const tokenType = ccc.Script.from({
  codeHash: `0x${"55".repeat(32)}`,
  hashType: "type",
  args: `0x${"66".repeat(36)}`,
});
const tokenData = ccc.hexFrom(ccc.numLeToBytes(1_000n, 16));

function settlement() {
  const tx = ccc.Transaction.from({
    inputs: [
      { previousOutput: { txHash: `0x${"77".repeat(32)}`, index: 0 } },
      { previousOutput: { txHash: `0x${"88".repeat(32)}`, index: 0 } },
    ],
    outputs: [
      { capacity: sellCapacity + price, lock: sellerLock },
      { lock: buyerLock, type: tokenType },
    ],
    outputsData: ["0x", tokenData],
    cellDeps: [
      { outPoint: { txHash: `0x${"99".repeat(32)}`, index: 0 }, depType: "code" },
      { outPoint: { txHash: `0x${"aa".repeat(32)}`, index: 0 }, depType: "code" },
    ],
  });
  return {
    tx,
    minimumTokenCapacity: tx.outputs[1].capacity,
    fee: tx.estimateFee(feeRate),
  };
}

const cases = [
  { name: "keeps a large refund in the buyer token cell", budget: () => 100n * CKB },
  { name: "keeps a small refund in the buyer token cell", budget: () => CKB },
  { name: "accepts exactly the fee with no excess", budget: (s: ReturnType<typeof settlement>) => s.fee },
];

for (const scenario of cases) {
  test(scenario.name, () => {
    const s = settlement();
    const buyCapacity = price + s.minimumTokenCapacity + scenario.budget(s);
    const allocation = allocateSettlementCapacity({ ...s, buyCapacity, price });
    assert.ok(allocation);

    s.tx.outputs[1].capacity = allocation.tokenCapacity;
    assert.equal(allocation.fee, s.tx.estimateFee(feeRate));
    assert.equal(buyCapacity + sellCapacity, s.tx.getOutputsCapacity() + allocation.fee);
    assert.equal(s.tx.outputs[0].capacity, sellCapacity + price);
    assert.equal(s.tx.outputs[0].lock.hash(), sellerLock.hash());
    assert.equal(s.tx.outputs[1].lock.hash(), buyerLock.hash());
    assert.equal(s.tx.outputs[1].type?.hash(), tokenType.hash());
    assert.equal(s.tx.outputsData[1], tokenData);
    assert.equal(s.tx.outputs.length, 2);
    assert.equal(s.tx.outputs[1].capacity, buyCapacity - price - allocation.fee);
    assert.ok(s.tx.outputs[1].capacity >= s.minimumTokenCapacity);
  });
}

test("rejects a buy order short by one shannon", () => {
  const s = settlement();
  const buyCapacity = price + s.minimumTokenCapacity + s.fee - 1n;
  assert.equal(allocateSettlementCapacity({ ...s, buyCapacity, price }), undefined);
});

test("preserves large u64 capacities without losing integer precision", () => {
  const s = settlement();
  const buyCapacity = 0xffff_ffff_ffff_ffffn;
  const allocation = allocateSettlementCapacity({ ...s, buyCapacity, price });
  assert.ok(allocation);
  assert.equal(price + allocation.tokenCapacity + allocation.fee, buyCapacity);
});

test("accepts a fee exactly at the contract cap", () => {
  const s = settlement();
  const buyCapacity = price + s.minimumTokenCapacity + MAX_SETTLEMENT_FEE;
  const allocation = allocateSettlementCapacity({ ...s, buyCapacity, price, fee: MAX_SETTLEMENT_FEE });
  assert.ok(allocation);
  assert.equal(allocation.tokenCapacity, s.minimumTokenCapacity);
});

test("rejects a fee one shannon above the cap even when the order has enough CKB", () => {
  const s = settlement();
  assert.throws(() => allocateSettlementCapacity({
    ...s,
    buyCapacity: price + s.minimumTokenCapacity + CKB,
    price,
    fee: MAX_SETTLEMENT_FEE + 1n,
  }), /exceeds.*contract cap/);
});

test("the builders' fee cap matches the authoritative contract constant", () => {
  const source = readFileSync(new URL("../../smart-contract/contracts/dex-order-lock/src/main.rs", import.meta.url), "utf8");
  const constant = source.match(/const MAX_SETTLEMENT_FEE: u64 = ([\d_]+);/);
  assert.ok(constant, "could not read the contract's fixed fee cap");
  assert.equal(MAX_SETTLEMENT_FEE, BigInt(constant[1].replaceAll("_", "")));
});
