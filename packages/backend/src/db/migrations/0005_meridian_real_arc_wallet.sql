-- Point Meridian Fabrication at the Arc address its own key already controls.
--
-- Its `arc_address` was `0x2Ee0aB7c…`, invented exactly as every seeded buyer's was, and
-- `0004` fixed the buyer side for the reason that is about to apply here: `MandateVault`
-- pays `_payouts[matchId].seller` into the Arc escrow, claimable by that address and no
-- other, so an invented one is a payout the seller cannot take. It sits until `reclaimPayout`
-- returns it to the buyer a day later — a sale that settles, reports success, and pays nobody.
--
-- The correction needs no new key and no invention, because the address already exists in
-- this row. `sellers.hedera_account_id` holds `0x2Da63Ac0…`, the operator's ECDSA alias, and
-- operator and seller are the same account in this build. An EVM address is derived from the
-- key rather than from a chain, so that one key controls the same address on Arc as it does
-- on Hedera. Verified by deriving it from `HEDERA_OPERATOR_KEY` rather than by assuming it.
--
-- This is the same property that makes a Privy wallet usable here: Privy is asked for no
-- chains, an address comes out of the key, and it is the same address everywhere. A seller
-- who signs in gets theirs from `POST /v1/sellers`; the seeded demo seller predates sign-in
-- and gets the one its key already had.
--
-- A plain UPDATE. No table rebuild, so like `0004` this applies through `pnpm db:migrate`
-- against a populated database.
UPDATE `sellers`
SET `arc_address` = '0x2Da63Ac0F6AE2C3059091d8DF38b3175a237ee71'
WHERE `name` = 'Meridian Fabrication';
