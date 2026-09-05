-- Changing a column default in SQLite means rebuilding the table, so this is drizzle-kit's
-- generated rebuild plus the row correction at the end.
--
-- `pnpm db:migrate` CANNOT APPLY THIS TO A DATABASE THAT HAS INVOICES IN IT, and the failure
-- is silent behind drizzle-kit's spinner - it exits 1 having printed nothing. The reason is
-- the first line: `PRAGMA foreign_keys=OFF` is a no-op inside a transaction, and drizzle-kit
-- wraps every migration in one. So enforcement stays on, and `DROP TABLE invoices` trips the
-- rows in trades, quotes, refusal_receipts, settlement_outcomes and confirmation_requests
-- that point at it. `PRAGMA defer_foreign_keys=ON` does not rescue it either: the drop's
-- implicit delete increments the deferred violation counter, and renaming the replacement
-- table back into place does not decrement it, so the failure just moves to COMMIT.
--
-- It applies cleanly to a fresh database, where no child rows exist to be violated, which is
-- the only case drizzle-kit's generator has in mind. Against a populated one, follow
-- SQLite's own documented table-rebuild order and put the pragma OUTSIDE the transaction:
--
--   PRAGMA foreign_keys = OFF;  BEGIN;  <every statement below>;  COMMIT;
--   PRAGMA foreign_keys = ON;   -- then verify integrity_check and foreign_key_check
--
-- That is how it was applied to the demo database on 2026-09-02, from a VACUUM INTO backup
-- taken with the server stopped, verified on a copy first.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_invoices` (
	`id` text PRIMARY KEY NOT NULL,
	`seller_id` text NOT NULL,
	`debtor_id` text NOT NULL,
	`invoice_number` text NOT NULL,
	`face_value` text NOT NULL,
	`currency` text(3) NOT NULL,
	`issued_at` integer NOT NULL,
	`due_at` integer NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`uniqueness_hash` text NOT NULL,
	`isin` text,
	`regulation_type` text DEFAULT 'reg-s' NOT NULL,
	`security_id` text,
	`security_evm_address` text,
	`issuance_state` text DEFAULT 'queued' NOT NULL,
	`issuance_attempts` integer DEFAULT 0 NOT NULL,
	`issuance_tx_id` text,
	`issuance_error` text,
	`confirmation_token_hash` text,
	`confirmation_requested_at` integer,
	`confirmation_expires_at` integer,
	`confirmation_decision` text,
	`confirmation_decided_at` integer,
	`confirmation_note` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`seller_id`) REFERENCES `sellers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`debtor_id`) REFERENCES `debtors`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_invoices`("id", "seller_id", "debtor_id", "invoice_number", "face_value", "currency", "issued_at", "due_at", "status", "uniqueness_hash", "isin", "regulation_type", "security_id", "security_evm_address", "issuance_state", "issuance_attempts", "issuance_tx_id", "issuance_error", "confirmation_token_hash", "confirmation_requested_at", "confirmation_expires_at", "confirmation_decision", "confirmation_decided_at", "confirmation_note", "created_at", "updated_at") SELECT "id", "seller_id", "debtor_id", "invoice_number", "face_value", "currency", "issued_at", "due_at", "status", "uniqueness_hash", "isin", "regulation_type", "security_id", "security_evm_address", "issuance_state", "issuance_attempts", "issuance_tx_id", "issuance_error", "confirmation_token_hash", "confirmation_requested_at", "confirmation_expires_at", "confirmation_decision", "confirmation_decided_at", "confirmation_note", "created_at", "updated_at" FROM `invoices`;--> statement-breakpoint
DROP TABLE `invoices`;--> statement-breakpoint
ALTER TABLE `__new_invoices` RENAME TO `invoices`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `invoices_uniqueness_hash_key` ON `invoices` (`uniqueness_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `invoices_isin_key` ON `invoices` (`isin`);--> statement-breakpoint
CREATE INDEX `invoices_seller_status_idx` ON `invoices` (`seller_id`,`status`);--> statement-breakpoint
CREATE INDEX `invoices_debtor_idx` ON `invoices` (`debtor_id`);--> statement-breakpoint
CREATE INDEX `invoices_due_at_idx` ON `invoices` (`due_at`);--> statement-breakpoint
CREATE INDEX `invoices_confirmation_token_idx` ON `invoices` (`confirmation_token_hash`);--> statement-breakpoint
-- The rows themselves, not just the column default. Seeded invoices were written before Reg S
-- was settled, and MF-2051 and MF-2052 went out `1/0` on chain while their rows still said
-- Reg D 506(c). The wire reports this field per invoice, so the proof view was describing
-- Reg S paper as Reg D. Where the chain and a stored value disagree the chain wins, and no
-- instrument this venue has ever deployed was Reg D.
UPDATE `invoices` SET `regulation_type` = 'reg-s' WHERE `regulation_type` <> 'reg-s';