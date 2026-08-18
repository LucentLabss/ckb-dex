# Fixed-Price DEX Order Lock

`dex-order-lock` is a simple fixed-price order contract for Nervos CKB.

It locks one typed asset Cell, intended to contain an xUDT, and allows that Cell
to be consumed in one of two ways:

1. A buyer fills the order by paying the maker the fixed ask price plus the
   Order Cell's capacity.
2. The maker cancels the order by including an input protected by the maker's
   lock script.

This is intentionally a small V1 contract. It supports full fills, CKB payment,
one order per transaction, and maker-authorized cancellation.

## Order Cell

The Order Cell is expected to contain:

| Part | Purpose |
| --- | --- |
| Capacity | CKB used by the Cell and returned to the maker during a fill |
| Lock | The `dex-order-lock` script |
| Type | A trusted typed-asset script, intended to be xUDT |
| Data | The token amount defined by the asset type script |

The DEX lock validates payment and cancellation. It does not implement token
accounting. The asset's type script is responsible for preserving the token
identity and amount.

## Lock Arguments

The lock arguments must contain exactly 40 bytes:

| Bytes | Size | Meaning |
| --- | ---: | --- |
| `0..32` | 32 bytes | Maker lock script hash |
| `32..40` | 8 bytes | Ask price in shannons as a little-endian `u64` |

```text
args = maker_lock_hash || ask_price.to_le_bytes()
```

The ask price is only the sale price. It does not include the Order Cell's
capacity.

```text
required maker capacity = order input capacity + ask price
```

## Fill Validation

A fill succeeds when all of these conditions are satisfied:

1. The lock arguments are exactly 40 bytes.
2. The transaction contains exactly one input using this DEX program.
3. No maker-locked input selects the cancellation path.
4. The Order Cell contains a type script.
5. Adding the order capacity and ask price does not overflow `u64`.
6. The total capacity of all plain CKB outputs locked by the maker is at least
   the required maker capacity.

The maker's payment may be split across multiple outputs. The contract sums
only outputs whose full lock script hash matches the maker lock hash and whose
type script is empty.

Typed maker outputs are ignored as payment. This prevents a buyer from
"paying" the maker with CKB locked inside an unexpected type script that may be
hard or impossible for the maker to spend.

The buyer does not appear in the lock arguments. Anyone may fill the order as
long as the transaction satisfies the maker's payment condition.

## Cancellation Validation

The maker cancels an order by including another input whose lock script hash
matches the maker lock hash stored in the DEX arguments.

That input's own lock script is responsible for authenticating the maker. The
DEX contract only detects the matching input and does not implement signature
verification.

The single-order rule is checked before cancellation. The cancellation path is
then checked before the typed-asset requirement, allowing the maker to recover
an accidentally untyped Order Cell.

## Why Only One Order?

V1 permits exactly one input using the DEX code hash and hash type.

If several orders were processed together, the same maker payment output could
be counted by more than one order. Supporting safe batch settlement would need
additional grouping and accounting rules, so it is outside this version.

## Script Responsibilities

| Component | Responsibility |
| --- | --- |
| DEX order lock | Validate maker payment or maker-authorized cancellation |
| xUDT type script | Enforce token identity, amount, and conservation |
| Maker lock | Authenticate cancellation |
| Buyer lock | Authorize spending the buyer's funding inputs |

The DEX lock only checks that a type script exists on the fill path. A
production Order Cell must therefore use a trusted asset type script such as
xUDT. An `always-success` type script is used only as a unit-test mock and does
not provide real token protection.

## Error Codes

| Code | Meaning |
| ---: | --- |
| `-1` | Failed to load the currently executing script |
| `-2` | Lock arguments are not exactly 40 bytes |
| `-3` | Failed to convert the maker bytes into a 32-byte array |
| `-4` | Failed to convert the price bytes into an 8-byte array |
| `-5` | Failed to load the Order Cell capacity |
| `-6` | Order capacity plus ask price overflowed `u64` |
| `-7` | Summing maker output capacities overflowed `u64` |
| `-8` | Failed to load a maker output's capacity |
| `-9` | Maker outputs contain insufficient capacity |
| `-10` | The transaction does not contain exactly one DEX order input |
| `-11` | The Order Cell has no type script on the fill path |
| `-12` | Failed to load the Order Cell's type script hash |
| `-13` | Failed to load a maker output's type script hash |

## Build

From `ckb-dapp/smart-contract`:

```bash
make run CONTRACT=dex-order-lock TASK=build
```

## Test

Run the DEX tests with:

```bash
cargo test -p tests test_dex_ -- --nocapture
```

The test suite covers:

- Correct fill
- Underpayment
- Payment to the wrong lock
- Typed maker payment outputs being ignored
- Maker-authorized cancellation
- Cancellation without maker authorization
- Malformed lock arguments
- Missing type script
- Multiple DEX order inputs
- Capacity addition overflow

The current successful-path measurements are:

```text
Fill:         44,214 cycles
Cancellation: 38,509 cycles
```

## V1 Limitations

This version does not support:

- Partial fills
- Multiple orders in one transaction
- Token-to-token payment
- Fees
- Variable pricing
- Order matching
- Liquidity pools
- A global on-chain order book

These exclusions keep the contract focused on one responsibility: safely
settling or cancelling one fixed-price order.
