# xUDT fixture

`xudt-testnet.json` contains the testnet xUDT binary used in contract tests.

- Outpoint: `0xbf6fb538763efec2a70a6a3dcb7242787087e1030c4e7d86585bc63a9d337f5f:0`.
- Data hash: `0x50bd8d6680b8b9cf98b73f3c08faf8b2a21914311954118ad6609be6e78a1b95`.
- Retrieved with `get_live_cell`.
- [Source](https://github.com/nervosnetwork/ckb-production-scripts)
- [xUDT specification](https://github.com/nervosnetwork/rfcs/blob/master/rfcs/0052-extensible-udt/0052-extensible-udt.md)

Tests check the binary's data hash before loading it into the local test
context. No network connection is needed.
