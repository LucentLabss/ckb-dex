# DEX Order Lock

`dex-order-lock` is the on-chain settlement and cancellation contract for the
CKB DEX proof of concept. One script handles both buy and sell orders.

Makers sign transactions that create their orders. A matcher can then settle a
valid buy and sell pair without either maker signing the settlement. A maker
authorizes cancellation by adding an input protected by their own lock script.

## Order Cell

Each order is a Cell whose lock is this DEX script.

| Side | Order Cell contents | What the maker expects when matched |
| --- | --- | --- |
| Buy | Plain CKB capacity reserved for the price, buyer's xUDT output, and any fee surplus | The exact xUDT type and amount under the maker's lock |
| Sell | The exact xUDT type and token amount, plus Cell capacity | Plain CKB equal to the price plus the sell Order Cell capacity |

The DEX lock validates the order terms and settlement outputs. The xUDT type
script validates token rules and conservation.

## Lock arguments

Arguments have a fixed length of 90 bytes:

| Bytes | Size | Meaning |
| --- | ---: | --- |
| `0` | 1 byte | Format version, currently `1` |
| `1` | 1 byte | Order side: `0` is buy, `1` is sell |
| `2..34` | 32 bytes | Maker lock script hash |
| `34..66` | 32 bytes | Expected xUDT type script hash |
| `66..82` | 16 bytes | Exact token amount as little-endian `u128` |
| `82..90` | 8 bytes | Total CKB price in shannons as little-endian `u64` |

The price is the total price for the full order, not a per-token price.

## Exact match validation

A settlement must consume exactly two inputs using this DEX code hash and hash
type. The inputs must contain one buy order and one sell order. Their xUDT type
hash, token amount, and total CKB price must be identical.

Both script groups validate the same pair. The buy order checks that the buyer
receives the exact token amount under the buy maker's lock. The sell order
checks that the seller receives plain CKB equal to the sell Order Cell capacity
plus the agreed price.

```text
Buy Order Cell capacity >= agreed price + buyer xUDT output capacity

Seller plain CKB outputs >= sell Order Cell capacity + agreed price
```

Any remaining capacity can contribute to the transaction fee. The transaction
still has to satisfy CKB's overall input and output capacity rules.

The DEX lock does not require signatures from either maker for settlement. The
matching bot builds and submits the transaction, while CKB runs both DEX lock
groups and the xUDT type script to validate it.

## Cancellation validation

A cancellation transaction must contain exactly one DEX Order Cell input and
at least one input whose lock script hash equals the maker lock hash in that
order's args. The maker's own lock script authenticates that input. The DEX
contract detects the maker input and allows the order to be consumed.

The DEX lock does not implement signature verification itself. It relies on
the maker input's lock script to do that.

## Validation details

The contract checks these rules:

1. The current order args use the supported 90-byte format, version, and side.
2. Cancellation consumes exactly one DEX order and includes maker authorization.
3. Settlement consumes exactly one buy order and one sell order.
4. Both orders declare the same xUDT type hash, amount, and total price.
5. A sell Order Cell has the declared xUDT type and exact declared amount.
6. The seller receives enough plain CKB, under the seller's lock, to cover the
   sell Order Cell capacity plus the price.
7. A buy Order Cell contains plain CKB and has enough capacity for the price and
   the buyer's matching xUDT output capacity.
8. The buy maker receives outputs with the declared xUDT type and exact total
   token amount.
9. Capacity and token sums use checked arithmetic and reject overflow.

The buyer token amount can be split across multiple outputs, provided their
lock hash is the buy maker's lock hash and their type hash matches the expected
xUDT type hash. The seller's CKB payment can also be split across multiple
plain CKB outputs under the seller's lock.

The contract only compares the expected type script hash and token data. A
production deployment must use a trusted xUDT type script. The unit tests use
`always-success` scripts as mocks, which do not provide real asset protection.

## Error codes

| Code | Meaning |
| ---: | --- |
| `-1` | Failed to load the current script |
| `-2` | Order args are not exactly 90 bytes |
| `-3` | Failed to convert maker hash bytes |
| `-4` | Failed to convert price bytes |
| `-5` | Failed to load an order capacity |
| `-6` | Capacity addition overflow |
| `-7` | Seller output capacity sum overflow |
| `-8` | Failed to load an output capacity |
| `-9` | Seller received insufficient plain CKB |
| `-10` | Invalid number of DEX inputs for match or cancellation |
| `-12` | Failed to load an order input type hash |
| `-13` | Failed to load an output type hash |
| `-14` | Unsupported order format version |
| `-15` | Unknown order side |
| `-16` | Failed to convert xUDT type hash bytes |
| `-17` | Invalid token amount bytes or data too short |
| `-18` | The buy and sell orders do not match |
| `-19` | Sell order input does not match its declared asset or amount |
| `-20` | Failed to load Cell data |
| `-21` | Buy maker received the wrong token amount or asset |
| `-22` | Token amount sum overflow |
| `-23` | Buyer token output capacity sum overflow |
| `-24` | Buy order capacity is insufficient |
| `-25` | Buy order input has a type script |

## Build and test

From `smart-contract/`, build the contract with:

```bash
make run CONTRACT=dex-order-lock TASK=build
```

Run the DEX tests with:

```bash
cargo test -p tests test_dex_
```

The tests cover a successful exact match, mismatched orders, wrong settlement
outputs, underfunded orders, malformed args, and maker-authorized cancellation.

## PoC limits

This version does not support partial fills, differing order amounts, price
improvement, multi-order settlement, other payment assets, or an on-chain order
book. Order discovery and matching are handled off-chain.
