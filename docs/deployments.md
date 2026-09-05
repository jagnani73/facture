# Deployed addresses

Testnet only. Recorded 2026-09-01.

## Hedera testnet (chain 296)

| contract                   | address                                      | bytes  |
| -------------------------- | -------------------------------------------- | ------ |
| `MandateBook`              | `0xcfafef6086caede6fad096523bd6e23db44e0d60` | 15,052 |
| `InvoiceRegistry`          | `0x471336f1058Ada6e4d79BD2F50e0CFED39883874` | 5,075  |
| `DvpEscrow` (delivery leg) | `0x7522344a12efbbbf5a7f43c05a69f26fa668eed6` | 4,412  |
| `UniquenessRegistry`       | `0x82ab4e85640b14070d337ef4d4d02c8974e7b0a8` | 1,554  |
| `AtsComplianceGate`        | `0xc65e6a706a98c847cad85ffda1f7e008b50f8af8` | 982    |

Verified on-chain after redeploy: `book.invoiceRegistry()` returns the registry above, and
`book.cashLeg()` returns `(5042002, 0x217256d0…)` — the Arc chain id and vault, both
immutables. The cross-chain link is recorded at construction and cannot be redirected.

## Arc testnet (chain 5042002)

| contract                  | address                                      | bytes |
| ------------------------- | -------------------------------------------- | ----- |
| `MandateVault`            | `0x217256d0fdf83ffd81bbc6884ad44f5c02501102` | 5,519 |
| `DvpEscrow` (payment leg) | `0x32e3511a2f3d941f776df01f6ba66a73caf10d69` | 4,412 |

Deploy order runs one way and never doubles back: Arc escrow, Arc vault, then the Hedera
book which records the vault. Deploying both contracts cost 0.047 USDC.

## ATS security (the paper)

|              |                                                               |
| ------------ | ------------------------------------------------------------- |
| bond         | `0.0.10316440` / `0x9cb3468607a359c214cb27159d5d5853d5e83877` |
| regulation   | Reg S (`1/0`), allowlist on, clearing later deactivated       |
| ISIN         | `US0000000010` (synthetic, checksum-valid)                    |
| supply       | 12,460,000 units issued across seller and a second holder     |
| `deployBond` | 7,016,307 gas, 7.928427 HBAR at 113 tinybar/gas               |

## Accounts

| role                   | id             | address                                      |
| ---------------------- | -------------- | -------------------------------------------- |
| operator / seller      | `0.0.10311549` | `0x2Da63Ac0F6AE2C3059091d8DF38b3175a237ee71` |
| security admin / buyer | `0.0.10314099` | `0xA25796399A9B3E8006d2d45Ff48a3B830C7f020B` |
| Arc deployer           | —              | `0x46783EeC3ec6e37f39F1EBc915b0b4996233b6A6` |
| Circle agent wallet    | —              | `0x1c755e95cb11e5d5af498bb0ea595b56e1adb035` |

## First settled trade — 2026-09-01

One receivable sold end to end on testnet. Both legs, against each other.

|           |                                                                         |
| --------- | ----------------------------------------------------------------------- |
| invoice   | MF-2046, Petra Foods Group, face $62,300, 94 days                       |
| priced at | 1850 bps, proceeds 5,933,178, discount 296,822                          |
| asset leg | `executeHoldByPartition`, tx `0.0.10311549@1788256893.030824576`        |
| cash leg  | x402 `exact` on `hedera:testnet`, tx `0.0.7162784@1788256891.347441683` |
| payer     | `0.0.10314099`                                                          |

On-chain result: `0.0.10314099 -5,933,178` and `0.0.10311549 +5,933,178`, with the
facilitator `0.0.7162784` paying the transaction fee. The buyer paid the seller the exact
quoted proceeds and paid **no gas**.

Known gap: `unitsMinor` transfers a token quantity that does not track face value, so the
paper moved but not in the right amount. The DvP mechanism is proven; the unit accounting
is not.
