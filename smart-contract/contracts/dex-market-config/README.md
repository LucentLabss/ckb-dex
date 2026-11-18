# DEX market configuration

This type script validates the creation and update of market configuration cells.
V2 orders reference a configuration by its full type-script hash. Settlement
reads it through `cell_deps`; updates require admin authorisation.

## Identity and authorisation

Args are a 32-byte Type ID:

```text
CKB blake2b(first serialized CellInput || configuration output index as LE u64)
```

The creation transaction must contain an input protected by the declared admin
lock. The policy output must also be protected by that lock. CKB executes the
admin's normal lock for signature verification.

Updates consume one configuration cell and create one with the same type.
Both remain admin-locked. The admin lock hash, assets, fee rates, lot/tick rules,
and quantity limits cannot change. The treasury lock hash and status may change.
Configuration destruction and duplicate successor cells are rejected.
Capacity cannot be reduced on update; use a separate admin input for fees.

New fee schedules require a new configuration cell and Type ID. Existing orders
retain their original fee schedule. Cancellation and timed refunds do not
require the configuration cell.

## Data: 214 bytes

All integers are unsigned little endian.

| Bytes | Field |
| --- | --- |
| 0 | version = 2 |
| 1..33 | admin lock hash |
| 33..65 | treasury lock hash |
| 65..97 | base full type hash; zeros mean native CKB |
| 97..129 | quote full type hash; zeros mean native CKB |
| 129..131 | maker fee in basis points, u16; initial schedule 10 |
| 131..133 | taker fee in basis points, u16; initial schedule 20 |
| 133..149 | lot size, u128 |
| 149..165 | minimum initial base quantity, u128 |
| 165..181 | maximum initial base quantity, u128 |
| 181..197 | price tick numerator, u128 |
| 197..213 | price tick denominator, u128 |
| 213 | status: 0 active, 1 paused, 2 closed |

Asset hashes must differ. Nonzero lot/tick values and valid quantity ranges
are required. Rates cannot exceed 10,000 bps.

The deployment registry lists recognised markets and admins. Authorisation is
per market; the script does not enforce a global admin allowlist.

Market discovery supplies display symbols, decimals, and the full treasury
script. Settlement checks the asset type hashes and treasury lock hash.

See [the settlement protocol](../dex-order-lock-v2/README.md) for order args,
witness layout, refunds, fees, and capacity accounting.
