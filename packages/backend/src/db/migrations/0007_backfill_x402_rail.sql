-- Say which rail the trades that already settled used.
--
-- `0006` added `cash_rail` nullable, which left all 27 existing trades reading "no rail has
-- run" — true of the column and false of the trades. Every one of them settled, or tried to,
-- over x402 on Hedera, which was the only rail that existed. The proof views for MF-2051 and
-- MF-2052 are the record of that, and they should name the rail rather than show a blank
-- where the fact belongs.
--
-- Scoped to rows that actually reached a rail. A trade with no `cash_network` never got as far
-- as building a challenge, so it has no rail and must keep saying so: backfilling those would
-- assert an x402 attempt that never happened, which is the same class of error as the
-- inference this column replaced.
UPDATE `trades`
SET `cash_rail` = 'x402'
WHERE `cash_rail` IS NULL AND `cash_network` IS NOT NULL;
