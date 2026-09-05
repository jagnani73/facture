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