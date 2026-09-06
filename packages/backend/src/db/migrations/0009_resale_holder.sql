/*
 * The secondary market: a holder relisting seasoned paper.
 *
 * Two additive columns, deliberately. `drizzle-kit generate` wanted to emit five more
 * alongside them — `chain_mandate_id`, `cash_rail`, `cash_amount_minor`, `arc_lock_id`
 * and `arc_secret` — because its snapshot predates the migrations those arrived in and
 * they were applied by hand. Every one of them already exists, so the generated file
 * would have failed on `duplicate column name` at the first statement. This is the same
 * hazard written up at the top of `0003`: the generator's picture of the database is not
 * the database.
 *
 * Both columns are nullable and neither rewrites a row, so this applies to a populated
 * book without the table-rebuild procedure `0003` needs.
 */
ALTER TABLE `trades` ADD `reseller_buyer_id` text REFERENCES buyers(id);--> statement-breakpoint
ALTER TABLE `trades` ADD `superseded_at` integer;
