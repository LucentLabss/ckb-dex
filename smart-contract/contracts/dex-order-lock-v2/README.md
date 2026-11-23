# Orderbook v2 order lock

Version 2 supports partial fills, market orders, and CKB/xUDT or xUDT/xUDT
pairs. It uses a separate binary from the deployed v1 contract and accepts
243-byte v2 orders.

Components:

- `dex-order-lock-v2`: settlement, successors, owner cancellation, timed refunds.
- `dex-market-config`: unique, admin-controlled market policy and treasury.
- `dex-v2-core`: shared encodings, state validation, and checked arithmetic.

The application and offchain builders still use v1.
Both new scripts require immutable `data2` code references. The market's Type ID
identifies the policy cell; it must not be used as an upgradeable code reference.

## Trading model

A market pins a base asset and a quote asset. Either asset may be native CKB;
both may be different xUDTs. An all-zero type hash identifies native CKB.
Other assets are identified by their full type-script hashes.

Buy orders escrow quote units plus a quote-denominated DEX-fee reserve.
Limit buys fund their entire remaining quantity at their limit price.
Sell orders escrow base units. Both orders also carry CKB capacity and a bounded
operating-cost budget. Token data is exactly a little-endian u128, 16 bytes.
Tokens requiring additional data or extension-specific rules are not supported.

The contract checks actual input/output types and amounts. Token conservation
is additionally enforced by the asset's type script. Market selection must pin
trusted full asset and configuration type-script identities.

Prices use integer ratios of quote-asset units to base-asset units, using each
asset's smallest unit. Display decimals are handled offchain. Orders use the market's tick
denominator; the numerator must be a positive multiple of its tick numerator.

## Settlement

A transaction consumes 2 to 16 v2 orders from the same market. The orders fund
the transaction; no additional funding inputs or maker signatures are required.

One input is the taker. Every other input is an opposite-side limit maker.
A market order can only be the taker. Limit orders may take other limit orders.
Market-to-market matching is rejected.

For each supplied maker:

- Execute at that maker's limit price.
- Round quote up for a sell maker, down for a buy maker.
- Require the execution to satisfy both parties' price limits.
- Enforce quantity, lot size, and the owner's minimum fill.
- Except for the final supplied maker, fully consume the better-priced maker.
- Require makers sorted best-price first within the submitted batch.
- Require the taker's quantities to equal the sum of all maker executions.

Price limits apply to gross trade value; DEX fees are additional for the buyer
and deducted from seller proceeds. Wallets must show the fee-inclusive cost.

The matcher selects orders and identifies the taker. Global price-time priority
and liquidity discovery are offchain. The contract checks the supplied batch's
price ordering and each order's execution bounds, but cannot verify arrival-time
priority or whether better orders exist outside the batch.

Each payout/refund/successor has an explicit, exclusive output index. Two
orders cannot count the same output, even if they have the same owner.
Unreferenced outputs, duplicate input nonces, mixed markets, and hidden
capacity destinations are rejected.

## Partial limit fills

Consume the old order and create exactly one successor if quantity remains.

The successor keeps the same owner, market, side, kind, nonce, initial
quantity, limit price, minimum fill, refund deadline, and per-operation caps.
Only these fields may change:

- Remaining base quantity.
- Remaining offered asset and buy-side DEX-fee reserve.
- Remaining CKB operating-cost budget.

The lock calculates the successor state from the execution amounts.
The successor escrows the remaining assets and retains enough
capacity for its state and remaining cost allowance. Full fills have no
successor. A successor's outpoint becomes the spendable order ID; the nonce
correlates its lineage. Clients generate unique nonces; the contract rejects
duplicate nonces within a settlement. Nonces do not establish creation time.

Successor creation transactions consume DEX orders, not owner-locked funding
cells. Input-based owner-script discovery must walk the verified successor
lineage back to the original creation, or retain the hash-validated owner script.

## Market orders

A market order has a worst acceptable execution price and a nonzero
refund-eligibility timestamp. It can execute against multiple limit makers.

Every execution closes the market order, even if partially filled. The owner
receives the purchased assets and unused offered assets/fee reserves. There
is no resting market-order successor. The matcher should collect the best
available liquidity into the bounded batch before submitting; the lock cannot
prove that no additional eligible orders existed elsewhere.

Unused native CKB can stay in the owner's received token cell. Unused offered
tokens return in a separate owner-locked token cell. No tokens are burned to
avoid making change.

## DEX fees and treasury

The initial fee schedule is 10 basis points (0.1%) for makers and 20 basis points
(0.2%) for takers. Rates are set in the market configuration. Both sides pay in
the quote asset.

Each execution charges:

```text
fee_this_execution = floor(executed_quote * applicable_rate_bps / 10,000)
```

Fees round down to whole quote units. Fees below one unit are zero, so splitting
trades can reduce the total fee through rounding. Market lot and minimum-order
settings should account for this.
The buyer's fee comes from its escrowed fee reserve; the seller's fee is
deducted from quote proceeds. Buy orders retain enough fee reserve to cover
their remaining quote budget at the higher of the maker/taker rates.

The treasury output must match the configured lock hash and quote asset and
contain exactly the sum of both sides' fees.

The admin may rotate the treasury or pause/close the market. Existing market
assets, fee rates, lot/tick rules, and quantity limits are immutable under that
configuration identity. A different fee schedule requires a new configuration
identity for future orders; existing orders retain their agreed policy.
The same treasury address can be used across markets, but rotation is an
admin-authorised update of each affected market cell.

## User-funded capacity and network fees

Orders fund three costs:

1. DEX trading fees: quote assets sent to the treasury.
2. Network fees: CKB paid to miners.
3. Cell capacity: CKB backing the created cells.

User-owned payouts, change, and successors retain their CKB value.
The operating-cost budget bounds irreversible CKB deductions: network fees
and any minimum treasury-cell capacity top-up.

A settlement creates one fresh treasury cell when fees are nonzero. Its
capacity is exactly the larger of its occupied capacity and native-CKB fees.
For token-denominated fees the entire minimum cell capacity must be funded.
The treasury owns this capacity. Wallets must show the additional CKB charge
before order creation. Small trades may be uneconomic. Existing treasury cells
are not reused.

Only the minimum top-up is allowed. It is divided equally among consumed
orders, with any integer remainder charged to the taker. Every share and
network fee reduces the corresponding order's remaining cost budget.
Network fees also have an owner-specified per-operation cap. Successors
cannot reset any budget.

For each order:

```text
input CKB + net native-CKB received - native-CKB spent
  = owned payout/change/successor CKB + network fee + treasury storage share
```

Across the transaction, total input capacity minus total output capacity must
equal the sum of the declared network-fee shares. The bot estimates these
shares from the transaction size and execution cost. Node relay and miner
fee policies still apply.

A new native-asset escrow needs its asset amount, occupied capacity, and cost
allowance. A token escrow needs occupied capacity and cost allowance. Extra
capacity is also needed for user-owned payout/change cells during partial
fills. A minimally occupied order cell is not necessarily enough to settle.

## Owner cancellation

Cancellation consumes exactly one v2 order at input 0 and includes an input
under the order owner's lock. That lock performs signature verification.

The refund preserves the original order's full type and data under the owner
lock. Its capacity is the original capacity minus the explicitly declared
refund fee, bounded by both the refund cap and remaining cost allowance.
Additional signed inputs may fund fees/change.

Cancellation does not require the market configuration cell or an active market.

## Permissionless timed refund

After the authorised timestamp, anyone may submit a refund without the owner
signing. It must have:

- One input: the order, at index 0.
- One output: the original assets/data returned to the owner.
- No successor, treasury fee, or unrelated output.
- An exact CKB deduction no greater than the refund cap and cost budget.
- An absolute timestamp `since` at least equal to `refund_after`.

```text
since = 0x4000000000000000 | refund_after_seconds
```

CKB consensus enforces the lower time bound. The testtool suite checks the
`since` encoding; maturity checks require a live-node test.

The timestamp enables refunds but does not disable settlement. A fill and a
refund can race after the deadline; only one can consume the order cell.
Bots should stop matching at the deadline and submit a refund transaction.

## Order lock args: 243 bytes

All integers are unsigned little endian. Hashes are 32 raw bytes.

| Bytes | Field |
| --- | --- |
| 0 | version = 2 |
| 1 | side: 0 buy, 1 sell |
| 2 | kind: 0 limit, 1 market |
| 3..35 | owner lock hash |
| 35..67 | market configuration full type-script hash |
| 67..99 | client nonce |
| 99..115 | price numerator, u128 |
| 115..131 | price denominator, u128 |
| 131..147 | initial base quantity, u128 |
| 147..163 | remaining base quantity, u128 |
| 163..179 | remaining offered asset, u128 |
| 179..195 | remaining buy-side fee reserve, u128; zero for sells |
| 195..203 | remaining CKB cost allowance, u64 shannons |
| 203..211 | maximum network fee per fill, u64 shannons |
| 211..219 | maximum refund fee, u64 shannons |
| 219..227 | refund-eligibility timestamp, u64 seconds; zero disables for limits |
| 227..243 | minimum base fill, u128 |

New orders start with initial = remaining quantity.
Sell offered amount equals remaining base; buy offered amount is its
quote-spending budget, excluding its separately escrowed DEX fee reserve.
Offered-token cell data equals offered amount plus fee reserve.

Builders using input-based owner-script discovery should include an owner-locked
funding input when creating the order. A lock hash cannot be reversed into its
full script. Alternatively, publish the script in order metadata and verify its hash.

The lock runs when an order is spent, not at creation. Clients must validate
initial state and funding before creating an order. Settlement uses the
consumed escrow and remaining state. Trading history must be derived from
verified transactions, not the initial-quantity field or nonce.

## Witnesses

The DEX payload lives in `WitnessArgs.lock` of transaction input 0.
The `input_type` field is reserved for xUDT.

Settlement header:

| Field | Size |
| --- | ---: |
| version = 2 | 1 |
| action = 0 | 1 |
| number of order inputs | 1 |
| taker input index | 1 |
| treasury output index | 4 |

Then one 60-byte record per input, in input order:

| Field | Size |
| --- | ---: |
| executed base quantity | 16 |
| executed gross quote quantity | 16 |
| payout output index | 4 |
| offered-asset refund output index | 4 |
| successor output index | 4 |
| network-fee share, shannons | 8 |
| treasury storage share, shannons | 8 |

Use `0xffffffff` for absent output indices. The payout is always required.
A partial limit fill requires exactly one successor and no refund index.
Market orders and full fills prohibit a successor. Token remainders require
a refund index; native remainders may be folded into the payout.

Cancellation/refund payload is exactly 14 bytes:

```text
version(1) + action(1) + refund_output_index(4) + network_fee(8)
```

Action 1 is owner cancellation; action 2 is permissionless timed refund.
Extra bytes, unsupported versions/actions, and oversized batches are rejected.

## Arithmetic and limits

Quantities and quote balances are u128. CKB capacities/budgets are u64.
Every arithmetic operation affecting assets or budgets is checked.
The u128 intermediate products for prices and fee numerators must fit;
orders requiring wider arithmetic are rejected, not wrapped or approximated.

A fill must be positive, in whole lots, and at least the order's minimum fill,
unless it consumes that order's complete remaining quantity. Native CKB/CKB
and identical-token markets are invalid.

No global book, matching bot, API, market discovery, AMM, or display-decimal
registry is implemented by these scripts.

## Build and test

From `smart-contract/`:

```bash
make run CONTRACT=dex-order-lock-v2 TASK=build
make run CONTRACT=dex-market-config TASK=build
cargo test -p tests v2_
```

For the complete contract suite, first build all contracts with `make build`,
then run `cargo test -p tests`.

Tests run the RISC-V binaries with the testnet xUDT binary for token-conservation
checks. Owner and admin locks use permissive mocks. Signature verification and
node-level maturity require separate integration tests.

Error codes are defined once in `crates/dex-v2-core/src/lib.rs`.
