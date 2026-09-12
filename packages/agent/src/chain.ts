/**
 * The chain facts this process operates against, fixed rather than configured.
 *
 * Each of these was an environment variable whose enum had exactly one reachable position.
 * Arc is testnet-only — mainnet lands after submissions close, so nothing in this build may
 * depend on it — and the x402 cash leg is `hedera:testnet` for the same reason. A variable
 * offering `hedera:mainnet` invites a value that would be parsed, accepted, and then fail
 * at the facilitator's exact-string kind lookup.
 *
 * The token address is not repeated here at all: it comes from `@facture/shared`, which is
 * where the backend and the web app read it from too.
 */

import { ARC_TESTNET } from '@facture/shared';
import type { TokenBlockchain } from '@circle-fin/developer-controlled-wallets';

/** Circle's identifier for Arc testnet. */
export const ARC_BLOCKCHAIN = 'ARC-TESTNET' as TokenBlockchain;

/**
 * USDC's ERC-20 address on Arc. 6 decimals on that interface; Arc's native gas accounting
 * uses 18 over the same balance, and the two must never meet in one calculation.
 */
export const ARC_USDC_ADDRESS = ARC_TESTNET.tokens.USDC.address;

/** CAIP-2, with a colon. The facilitator matches this string exactly; a hyphen matches nothing. */
export const HEDERA_NETWORK = 'hedera:testnet' as const;
