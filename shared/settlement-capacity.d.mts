export const MAX_SETTLEMENT_FEE: bigint;

export interface SettlementCapacityInput {
  buyCapacity: bigint;
  price: bigint;
  minimumTokenCapacity: bigint;
  fee: bigint;
}

export interface SettlementCapacity {
  tokenCapacity: bigint;
  fee: bigint;
}

export function allocateSettlementCapacity(
  input: SettlementCapacityInput,
): SettlementCapacity | undefined;
