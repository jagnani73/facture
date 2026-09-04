CREATE TYPE "public"."confirmation_decision" AS ENUM('confirmed', 'disputed');--> statement-breakpoint
CREATE TYPE "public"."invoice_status" AS ENUM('draft', 'awaiting_confirmation', 'confirmed', 'listed', 'sold', 'matured', 'defaulted', 'disputed');--> statement-breakpoint
CREATE TYPE "public"."issuance_state" AS ENUM('queued', 'issuing', 'issued', 'failed');--> statement-breakpoint
CREATE TYPE "public"."mandate_status" AS ENUM('draft', 'funding', 'active', 'exhausted', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."quote_status" AS ENUM('live', 'accepted', 'expired', 'superseded');--> statement-breakpoint
CREATE TYPE "public"."rating_grade" AS ENUM('D', 'UNRATED', 'C', 'B', 'A');--> statement-breakpoint
CREATE TYPE "public"."regulation_type" AS ENUM('reg-d-506b', 'reg-d-506c', 'reg-s');--> statement-breakpoint
CREATE TYPE "public"."settlement_outcome" AS ENUM('on_time', 'late', 'default');--> statement-breakpoint
CREATE TYPE "public"."trade_status" AS ENUM('preparing', 'awaiting_payment', 'settled', 'unwound', 'failed');--> statement-breakpoint
CREATE TABLE "buyers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"hedera_account_id" text,
	"arc_address" text,
	"agent_policy" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "confirmation_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"superseded_at" timestamp with time zone,
	"decision" "confirmation_decision",
	"decided_at" timestamp with time zone,
	"note" text
);
--> statement-breakpoint
CREATE TABLE "debtors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"tax_id" text,
	"rating" "rating_grade" DEFAULT 'UNRATED' NOT NULL,
	"settled_on_time" integer DEFAULT 0 NOT NULL,
	"settled_late" integer DEFAULT 0 NOT NULL,
	"defaulted" integer DEFAULT 0 NOT NULL,
	"settled_face_value" bigint DEFAULT 0 NOT NULL,
	"first_settlement_at" timestamp with time zone,
	"last_settlement_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "indexer_cursors" (
	"chain" text PRIMARY KEY NOT NULL,
	"cursor" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seller_id" uuid NOT NULL,
	"debtor_id" uuid NOT NULL,
	"invoice_number" text NOT NULL,
	"face_value" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"status" "invoice_status" DEFAULT 'draft' NOT NULL,
	"uniqueness_hash" text NOT NULL,
	"isin" text,
	"regulation_type" "regulation_type" DEFAULT 'reg-d-506c' NOT NULL,
	"security_id" text,
	"security_evm_address" text,
	"issuance_state" "issuance_state" DEFAULT 'queued' NOT NULL,
	"issuance_attempts" integer DEFAULT 0 NOT NULL,
	"issuance_tx_id" text,
	"issuance_error" text,
	"confirmation_token_hash" text,
	"confirmation_requested_at" timestamp with time zone,
	"confirmation_expires_at" timestamp with time zone,
	"confirmation_decision" "confirmation_decision",
	"confirmation_decided_at" timestamp with time zone,
	"confirmation_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issuance_jobs" (
	"invoice_id" uuid PRIMARY KEY NOT NULL,
	"state" "issuance_state" DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone,
	"last_error" text
);
--> statement-breakpoint
CREATE TABLE "mandates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"buyer_id" uuid NOT NULL,
	"rating_floor" "rating_grade" NOT NULL,
	"max_tenor_days" integer NOT NULL,
	"annualised_yield_bps" integer NOT NULL,
	"currency" char(3) NOT NULL,
	"exposure_limit_minor" bigint NOT NULL,
	"per_debtor_limit_minor" bigint,
	"funded_minor" bigint DEFAULT 0 NOT NULL,
	"allocated_minor" bigint DEFAULT 0 NOT NULL,
	"escrow_ref" text,
	"status" "mandate_status" DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quotes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"mandate_id" uuid,
	"rating_at_quote" "rating_grade" NOT NULL,
	"tenor_days" integer NOT NULL,
	"annualised_yield_bps" integer NOT NULL,
	"face_value" bigint NOT NULL,
	"discount_minor" bigint NOT NULL,
	"proceeds_minor" bigint NOT NULL,
	"status" "quote_status" DEFAULT 'live' NOT NULL,
	"priced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refusal_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"mandate_id" uuid NOT NULL,
	"buyer_id" uuid NOT NULL,
	"reason_code" text NOT NULL,
	"reason_text" text NOT NULL,
	"rating_at_refusal" "rating_grade" NOT NULL,
	"tenor_days_at_refusal" integer NOT NULL,
	"hcs_topic_id" text,
	"hcs_sequence_number" bigint,
	"hcs_consensus_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sellers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"hedera_account_id" text,
	"arc_address" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settlement_outcomes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"debtor_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"outcome" "settlement_outcome" NOT NULL,
	"face_value" bigint NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trades" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"mandate_id" uuid NOT NULL,
	"quote_id" uuid NOT NULL,
	"seller_id" uuid NOT NULL,
	"buyer_id" uuid NOT NULL,
	"face_value" bigint NOT NULL,
	"proceeds_minor" bigint NOT NULL,
	"annualised_yield_bps" integer NOT NULL,
	"tenor_days" integer NOT NULL,
	"status" "trade_status" DEFAULT 'preparing' NOT NULL,
	"hold_id" text,
	"asset_tx_id" text,
	"asset_consensus_at" timestamp with time zone,
	"cash_scheme" text,
	"cash_network" text,
	"cash_asset" text,
	"cash_transaction" text,
	"cash_payer" text,
	"compliance_decision" jsonb,
	"compliance_checked_at" timestamp with time zone,
	"hcs_topic_id" text,
	"hcs_sequence_number" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "confirmation_requests" ADD CONSTRAINT "confirmation_requests_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_seller_id_sellers_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."sellers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_debtor_id_debtors_id_fk" FOREIGN KEY ("debtor_id") REFERENCES "public"."debtors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issuance_jobs" ADD CONSTRAINT "issuance_jobs_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mandates" ADD CONSTRAINT "mandates_buyer_id_buyers_id_fk" FOREIGN KEY ("buyer_id") REFERENCES "public"."buyers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_mandate_id_mandates_id_fk" FOREIGN KEY ("mandate_id") REFERENCES "public"."mandates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refusal_receipts" ADD CONSTRAINT "refusal_receipts_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refusal_receipts" ADD CONSTRAINT "refusal_receipts_mandate_id_mandates_id_fk" FOREIGN KEY ("mandate_id") REFERENCES "public"."mandates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refusal_receipts" ADD CONSTRAINT "refusal_receipts_buyer_id_buyers_id_fk" FOREIGN KEY ("buyer_id") REFERENCES "public"."buyers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_outcomes" ADD CONSTRAINT "settlement_outcomes_debtor_id_debtors_id_fk" FOREIGN KEY ("debtor_id") REFERENCES "public"."debtors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_outcomes" ADD CONSTRAINT "settlement_outcomes_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_mandate_id_mandates_id_fk" FOREIGN KEY ("mandate_id") REFERENCES "public"."mandates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_quote_id_quotes_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."quotes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_seller_id_sellers_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."sellers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_buyer_id_buyers_id_fk" FOREIGN KEY ("buyer_id") REFERENCES "public"."buyers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "buyers_email_key" ON "buyers" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "confirmation_requests_token_key" ON "confirmation_requests" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "confirmation_requests_invoice_idx" ON "confirmation_requests" USING btree ("invoice_id","requested_at");--> statement-breakpoint
CREATE UNIQUE INDEX "debtors_email_key" ON "debtors" USING btree ("email");--> statement-breakpoint
CREATE INDEX "debtors_rating_idx" ON "debtors" USING btree ("rating");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_uniqueness_hash_key" ON "invoices" USING btree ("uniqueness_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_isin_key" ON "invoices" USING btree ("isin");--> statement-breakpoint
CREATE INDEX "invoices_seller_status_idx" ON "invoices" USING btree ("seller_id","status");--> statement-breakpoint
CREATE INDEX "invoices_debtor_idx" ON "invoices" USING btree ("debtor_id");--> statement-breakpoint
CREATE INDEX "invoices_due_at_idx" ON "invoices" USING btree ("due_at");--> statement-breakpoint
CREATE INDEX "invoices_confirmation_token_idx" ON "invoices" USING btree ("confirmation_token_hash");--> statement-breakpoint
CREATE INDEX "issuance_jobs_state_idx" ON "issuance_jobs" USING btree ("state","next_attempt_at");--> statement-breakpoint
CREATE INDEX "mandates_buyer_status_idx" ON "mandates" USING btree ("buyer_id","status");--> statement-breakpoint
CREATE INDEX "mandates_curve_idx" ON "mandates" USING btree ("status","rating_floor","max_tenor_days","annualised_yield_bps");--> statement-breakpoint
CREATE INDEX "quotes_invoice_priced_idx" ON "quotes" USING btree ("invoice_id","priced_at");--> statement-breakpoint
CREATE INDEX "refusals_invoice_idx" ON "refusal_receipts" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "refusals_mandate_idx" ON "refusal_receipts" USING btree ("mandate_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sellers_email_key" ON "sellers" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "settlement_outcomes_receivable_key" ON "settlement_outcomes" USING btree ("debtor_id","invoice_id");--> statement-breakpoint
CREATE INDEX "settlement_outcomes_debtor_idx" ON "settlement_outcomes" USING btree ("debtor_id");--> statement-breakpoint
CREATE INDEX "trades_invoice_idx" ON "trades" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "trades_buyer_idx" ON "trades" USING btree ("buyer_id","status");--> statement-breakpoint
CREATE INDEX "trades_seller_idx" ON "trades" USING btree ("seller_id","status");