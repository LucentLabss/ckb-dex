# CKB DEX PoC

This repository contains a proof of concept for an exact-fill order book on
Nervos CKB. Makers create buy or sell Order Cells. A matching bot finds a
compatible pair and submits one transaction that consumes both orders.

Makers sign when they create or cancel their orders. Matching is
permissionless: no maker signature is required to settle a valid pair.

## Order model

The PoC supports full exact matches only. A buy and sell order must specify the
same xUDT type, token amount, and total CKB price.

```text
Buy order:  maker locks enough CKB for the price and buyer token Cell
Sell order: maker locks the exact xUDT amount

Match:
  seller receives the price plus the sell Order Cell capacity
  buyer receives the exact xUDT amount
```

Each match consumes exactly one buy Order Cell and one sell Order Cell. The
contract validates both sides. A maker can cancel an order by including a
maker-locked input in a transaction that consumes only that one DEX Order Cell.

## Order lock arguments

The current version uses exactly 90 bytes:

| Bytes | Size | Meaning |
| --- | ---: | --- |
| `0` | 1 byte | Format version, currently `1` |
| `1` | 1 byte | Side: `0` for buy, `1` for sell |
| `2..34` | 32 bytes | Maker lock script hash |
| `34..66` | 32 bytes | Expected xUDT type script hash |
| `66..82` | 16 bytes | Exact token amount as little-endian `u128` |
| `82..90` | 8 bytes | Total CKB price in shannons as little-endian `u64` |

The lock args record the terms the contract must enforce. The maker lock hash
commits to the complete maker lock script. A matcher may recover the full lock
from the order creation transaction's input Cells, then verify its hash against
the value in the args.

## Script responsibilities

| Component | Responsibility |
| --- | --- |
| DEX order lock | Enforces buy and sell terms, exact pair matching, and maker cancellation |
| xUDT type script | Enforces token validity and token conservation |
| Maker lock | Authenticates order creation and cancellation inputs |
| Matching bot | Discovers orders, selects matching pairs, builds and submits settlement transactions |

The bot is not trusted to enforce settlement. The DEX lock scripts and xUDT
type script validate the transaction on-chain.

## Scope and limitations

This PoC supports:

- xUDT buy and sell orders paid in CKB.
- Exact full fills with equal token type, amount, and price.
- One buy order and one sell order per settlement transaction.
- Permissionless matching and settlement.
- Maker-authorized cancellation of one order.

It does not support partial fills, price improvement, matching orders with
differing amounts, multi-order settlement, or a global on-chain order book.
The matching bot and off-chain services provide order discovery and matching.

## Development

Smart contract source, build instructions, and tests are in `smart-contract/`.
The DEX lock's validation details and error codes are documented in
[`smart-contract/contracts/dex-order-lock/README.md`](smart-contract/contracts/dex-order-lock/README.md).

From `smart-contract/`, build the DEX contract with:

```bash
make run CONTRACT=dex-order-lock TASK=build
```

Run its tests with:

```bash
cargo test -p tests test_dex_
```
