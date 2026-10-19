// Both settlement builders use this allocation so surplus never becomes an accidental fee.
// Mirrors the contract constant; the refund tests check that these limits agree.
export const MAX_SETTLEMENT_FEE = 10_000n;

export function allocateSettlementCapacity({
  buyCapacity,
  price,
  minimumTokenCapacity,
  fee,
}) {
  if (fee > MAX_SETTLEMENT_FEE) {
    throw new RangeError(`Settlement fee exceeds the ${MAX_SETTLEMENT_FEE}-shannon contract cap`);
  }
  const tokenCapacity = buyCapacity - price - fee;
  if (tokenCapacity < minimumTokenCapacity) return undefined;

  // Keep all remaining CKB in the buyer's existing xUDT cell.
  return { tokenCapacity, fee };
}
