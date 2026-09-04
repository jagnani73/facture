CREATE TABLE `buyers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`hedera_account_id` text,
	`arc_address` text,
	`agent_policy` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `buyers_email_key` ON `buyers` (`email`);--> statement-breakpoint
CREATE TABLE `confirmation_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`invoice_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`requested_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`expires_at` integer NOT NULL,
	`consumed_at` integer,
	`superseded_at` integer,
	`decision` text,
	`decided_at` integer,
	`note` text,
	FOREIGN KEY (`invoice_id`) REFERENCES `invoices`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `confirmation_requests_token_key` ON `confirmation_requests` (`token_hash`);--> statement-breakpoint
CREATE INDEX `confirmation_requests_invoice_idx` ON `confirmation_requests` (`invoice_id`,`requested_at`);--> statement-breakpoint
CREATE TABLE `debtors` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`tax_id` text,
	`rating` text DEFAULT 'UNRATED' NOT NULL,
	`settled_on_time` integer DEFAULT 0 NOT NULL,
	`settled_late` integer DEFAULT 0 NOT NULL,
	`defaulted` integer DEFAULT 0 NOT NULL,
	`settled_face_value` text DEFAULT '0' NOT NULL,
	`first_settlement_at` integer,
	`last_settlement_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `debtors_email_key` ON `debtors` (`email`);--> statement-breakpoint
CREATE INDEX `debtors_rating_idx` ON `debtors` (`rating`);--> statement-breakpoint
CREATE TABLE `indexer_cursors` (
	`chain` text PRIMARY KEY NOT NULL,
	`cursor` text NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `invoices` (
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
	`regulation_type` text DEFAULT 'reg-d-506c' NOT NULL,
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
CREATE UNIQUE INDEX `invoices_uniqueness_hash_key` ON `invoices` (`uniqueness_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `invoices_isin_key` ON `invoices` (`isin`);--> statement-breakpoint
CREATE INDEX `invoices_seller_status_idx` ON `invoices` (`seller_id`,`status`);--> statement-breakpoint
CREATE INDEX `invoices_debtor_idx` ON `invoices` (`debtor_id`);--> statement-breakpoint
CREATE INDEX `invoices_due_at_idx` ON `invoices` (`due_at`);--> statement-breakpoint
CREATE INDEX `invoices_confirmation_token_idx` ON `invoices` (`confirmation_token_hash`);--> statement-breakpoint
CREATE TABLE `issuance_jobs` (
	`invoice_id` text PRIMARY KEY NOT NULL,
	`state` text DEFAULT 'queued' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`queued_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`started_at` integer,
	`completed_at` integer,
	`next_attempt_at` integer,
	`last_error` text,
	FOREIGN KEY (`invoice_id`) REFERENCES `invoices`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `issuance_jobs_state_idx` ON `issuance_jobs` (`state`,`next_attempt_at`);--> statement-breakpoint
CREATE TABLE `mandates` (
	`id` text PRIMARY KEY NOT NULL,
	`buyer_id` text NOT NULL,
	`rating_floor` text NOT NULL,
	`max_tenor_days` integer NOT NULL,
	`annualised_yield_bps` integer NOT NULL,
	`currency` text(3) NOT NULL,
	`exposure_limit_minor` text NOT NULL,
	`per_debtor_limit_minor` text,
	`funded_minor` text DEFAULT '0' NOT NULL,
	`allocated_minor` text DEFAULT '0' NOT NULL,
	`escrow_ref` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`buyer_id`) REFERENCES `buyers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `mandates_buyer_status_idx` ON `mandates` (`buyer_id`,`status`);--> statement-breakpoint
CREATE INDEX `mandates_curve_idx` ON `mandates` (`status`,`rating_floor`,`max_tenor_days`,`annualised_yield_bps`);--> statement-breakpoint
CREATE TABLE `quotes` (
	`id` text PRIMARY KEY NOT NULL,
	`invoice_id` text NOT NULL,
	`mandate_id` text,
	`rating_at_quote` text NOT NULL,
	`tenor_days` integer NOT NULL,
	`annualised_yield_bps` integer NOT NULL,
	`face_value` text NOT NULL,
	`discount_minor` text NOT NULL,
	`proceeds_minor` text NOT NULL,
	`status` text DEFAULT 'live' NOT NULL,
	`priced_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`invoice_id`) REFERENCES `invoices`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`mandate_id`) REFERENCES `mandates`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `quotes_invoice_priced_idx` ON `quotes` (`invoice_id`,`priced_at`);--> statement-breakpoint
CREATE TABLE `refusal_receipts` (
	`id` text PRIMARY KEY NOT NULL,
	`invoice_id` text NOT NULL,
	`mandate_id` text NOT NULL,
	`buyer_id` text NOT NULL,
	`reason_code` text NOT NULL,
	`reason_text` text NOT NULL,
	`rating_at_refusal` text NOT NULL,
	`tenor_days_at_refusal` integer NOT NULL,
	`hcs_topic_id` text,
	`hcs_sequence_number` text,
	`hcs_consensus_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`invoice_id`) REFERENCES `invoices`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`mandate_id`) REFERENCES `mandates`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`buyer_id`) REFERENCES `buyers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `refusals_invoice_idx` ON `refusal_receipts` (`invoice_id`);--> statement-breakpoint
CREATE INDEX `refusals_mandate_idx` ON `refusal_receipts` (`mandate_id`);--> statement-breakpoint
CREATE TABLE `sellers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`hedera_account_id` text,
	`arc_address` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sellers_email_key` ON `sellers` (`email`);--> statement-breakpoint
CREATE TABLE `settlement_outcomes` (
	`id` text PRIMARY KEY NOT NULL,
	`debtor_id` text NOT NULL,
	`invoice_id` text NOT NULL,
	`outcome` text NOT NULL,
	`face_value` text NOT NULL,
	`occurred_at` integer NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`debtor_id`) REFERENCES `debtors`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`invoice_id`) REFERENCES `invoices`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `settlement_outcomes_receivable_key` ON `settlement_outcomes` (`debtor_id`,`invoice_id`);--> statement-breakpoint
CREATE INDEX `settlement_outcomes_debtor_idx` ON `settlement_outcomes` (`debtor_id`);--> statement-breakpoint
CREATE TABLE `trades` (
	`id` text PRIMARY KEY NOT NULL,
	`invoice_id` text NOT NULL,
	`mandate_id` text NOT NULL,
	`quote_id` text NOT NULL,
	`seller_id` text NOT NULL,
	`buyer_id` text NOT NULL,
	`face_value` text NOT NULL,
	`proceeds_minor` text NOT NULL,
	`annualised_yield_bps` integer NOT NULL,
	`tenor_days` integer NOT NULL,
	`status` text DEFAULT 'preparing' NOT NULL,
	`hold_id` text,
	`asset_tx_id` text,
	`asset_consensus_at` integer,
	`cash_scheme` text,
	`cash_network` text,
	`cash_asset` text,
	`cash_transaction` text,
	`cash_payer` text,
	`compliance_decision` text,
	`compliance_checked_at` integer,
	`hcs_topic_id` text,
	`hcs_sequence_number` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`settled_at` integer,
	FOREIGN KEY (`invoice_id`) REFERENCES `invoices`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`mandate_id`) REFERENCES `mandates`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`quote_id`) REFERENCES `quotes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`seller_id`) REFERENCES `sellers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`buyer_id`) REFERENCES `buyers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `trades_invoice_idx` ON `trades` (`invoice_id`);--> statement-breakpoint
CREATE INDEX `trades_buyer_idx` ON `trades` (`buyer_id`,`status`);--> statement-breakpoint
CREATE INDEX `trades_seller_idx` ON `trades` (`seller_id`,`status`);