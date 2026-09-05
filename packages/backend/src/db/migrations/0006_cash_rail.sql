-- Record which rail settled a trade, and what actually moved.
--
-- `cash_rail` replaces an inference. Two places derived the cash chain from
-- `cash_network.startsWith('hedera')` and defaulted to Arc when the network was null, so an
-- unsettled trade rendered as an Arc trade and the two copies of the guess could drift. A
-- funded mandate settles out of its escrow on Arc; an unfunded one settles pay-as-you-go over
-- x402 on Hedera. Which happened is a fact, not a string prefix.
--
-- `cash_amount_minor` closes a gap that predates both rails: every amount on this table is
-- invoice currency, and the money that changed hands is that figure scaled by
-- X402_SETTLEMENT_SCALE_PPM into the settlement asset's own units. Nothing recorded it, so the
-- receipt read "$59,331.78" beside a transaction that moved 0.059331 USDC.
--
-- `arc_lock_id` and `arc_secret` are the escrow lock a payout opens and the preimage that
-- releases it. Both must survive a restart: without the lock id the venue cannot tell whether
-- the seller was paid, and without the secret nobody can ever claim it — the lock times out,
-- `reclaimPayout` returns the capital to the buyer, and `payout.executed` stays true forever,
-- so that match can never be paid again. The secret is not a credential; `DvpEscrow.claim`
-- publishes it in the clear, because that log is the cross-chain channel.
--
-- Four plain ADD COLUMNs, all nullable. No table rebuild, so unlike `0003` this applies
-- through `pnpm db:migrate` against a populated database.
ALTER TABLE `trades` ADD `cash_rail` text;
--> statement-breakpoint
ALTER TABLE `trades` ADD `cash_amount_minor` text;
--> statement-breakpoint
ALTER TABLE `trades` ADD `arc_lock_id` text;
--> statement-breakpoint
ALTER TABLE `trades` ADD `arc_secret` text;
