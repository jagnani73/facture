'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';

import { ASSET_CHAIN, CASH_CHAIN, CHAINS, REGULATIONS, explorerTxUrl } from '@/lib/domain';
import { elide, formatDate, formatDateTime, formatMoney, formatRate } from '@/lib/format';
import type { ProofRecord } from '@/lib/data';
import { useProof } from '@/lib/data/hooks';
import { Failure, Pending } from '@/components/ui/async';
import { Card, CardHead, Label, PageHeader, Row, buttonClasses } from '@/components/ui/primitives';

/**
 * The proof view.
 *
 * This is the one screen in Facture where the machinery is named. Everywhere else a buyer
 * sees exposure and yield and a seller sees a price, because every primitive in this
 * market already has a plain financial name. Here, one click from any trade, the receipts
 * are shown as they are — with the identifiers to check them somewhere that is not this
 * website.
 *
 * Every row is conditional on the venue having actually published the identifier behind
 * it. A row is omitted rather than filled with a dash, and no explorer link is built out
 * of an identifier that is missing: a link that 404s makes a worse claim than an absent
 * one, and this is the screen whose entire job is not overclaiming.
 */

const HEDERA = CHAINS[ASSET_CHAIN];
const ARC = CHAINS[CASH_CHAIN];

export function ProofView({ tradeId }: { tradeId: string }) {
  const proof = useProof(tradeId);

  if (proof.status === 'loading')
    return <Pending what="the receipts behind this trade" lines={5} />;

  if (proof.status === 'failed') {
    return (
      <Failure error={proof.error} what="the proof of this trade" onRetry={proof.reload}>
        Nothing is shown here that has not been read back from the record. An unverified receipt is
        not a receipt.
      </Failure>
    );
  }

  if (proof.data === null) {
    return (
      <Card className="px-6 py-10 text-center">
        <p className="text-sm text-muted">No settled trade with that reference.</p>
        <Link href="/book" className={`${buttonClasses('secondary')} mt-4`}>
          Back to the book
        </Link>
      </Card>
    );
  }

  return <Proof record={proof.data} />;
}

function Proof({ record }: { record: ProofRecord }) {
  const { trade } = record;
  const settledAt = record.settledAt ?? trade.settledAt ?? trade.executedAt;

  const assetTx = record.assetLeg.transactionId ?? trade.assetLeg.reference ?? null;
  const cashTx = record.cashLeg.transaction ?? trade.cashLeg.reference ?? null;
  const assetExplorer =
    record.assetLeg.explorerUrl ?? (assetTx ? explorerTxUrl(ASSET_CHAIN, assetTx) : null);
  const cashExplorer =
    record.cashLeg.explorerUrl ?? (cashTx ? explorerTxUrl(CASH_CHAIN, cashTx) : null);

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow={`Trade ${trade.id}`}
        title="Proof of settlement"
        lede="Every other screen here is a market, in ordinary financial language. This one shows the machinery, because a claim about settlement is worth nothing if you cannot check it somewhere that is not us."
        actions={
          <Link
            href={`/book/${encodeURIComponent(trade.invoiceId)}`}
            className={buttonClasses('secondary')}
          >
            Back to the invoice
          </Link>
        }
      />

      <Card className="grid gap-px bg-rule sm:grid-cols-4">
        <Summary
          label="Invoice"
          value={record.invoiceNumber ?? trade.invoiceId}
          note={record.debtorName ?? ''}
        />
        <Summary
          label="Face at maturity"
          value={formatMoney(trade.faceValue, { fractionDigits: 0 })}
          note={record.instrument.maturity ? `due ${formatDate(record.instrument.maturity)}` : ''}
        />
        <Summary
          label="Paid to the seller"
          value={formatMoney(trade.proceeds)}
          note={`${formatRate(trade.annualisedYieldBps)} over ${trade.tenorDays} days`}
        />
        <Summary
          label="Settled"
          value={formatDate(settledAt)}
          note={`${secondsBetween(trade.executedAt, settledAt)}s after the match`}
        />
      </Card>

      <ol className="grid gap-px overflow-hidden rounded-md border border-rule bg-rule sm:grid-cols-5">
        <Step
          n={1}
          title="Issued"
          at={record.instrument.issuedAt}
          note="At onboarding, not at sale"
        />
        <Step
          n={2}
          title="Checked"
          at={record.compliance.checkedAt}
          note="Before matching, not after"
        />
        <Step
          n={3}
          title="Matched"
          at={trade.executedAt}
          note={record.buyerName ?? 'The best standing bid'}
        />
        <Step
          n={4}
          title="Bound"
          at={record.settlement?.boundAt ?? null}
          note="Both legs, one challenge"
        />
        <Step n={5} title="Settled" at={settledAt} note="Delivery versus payment" />
      </ol>

      <div className="grid gap-6 lg:grid-cols-2">
        <InstrumentCard record={record} />
        <ComplianceCard record={record} />
      </div>

      <Card>
        <CardHead
          title="Both legs of the settlement"
          hint="The paper never left Hedera and the cash never left Arc. There is no bridge here and nothing is wrapped — the two legs are bound to one challenge, so neither can settle without the other."
        />

        <div className="grid gap-px bg-rule md:grid-cols-2">
          <div className="bg-raised px-5 py-5">
            <Label className="mb-3">Asset leg · {HEDERA.name}</Label>
            <Row term="State" value={trade.assetLeg.state} />
            {record.assetLeg.quantity ? (
              <Row term="Transferred" value={record.assetLeg.quantity} />
            ) : null}
            {record.assetLeg.from ? (
              <Row term="From" value={<Mono>{record.assetLeg.from}</Mono>} />
            ) : null}
            {record.assetLeg.to ? (
              <Row term="To" value={<Mono>{record.assetLeg.to}</Mono>} />
            ) : null}
            {record.assetLeg.holdId ? (
              <Row term="Hold" value={<Mono>{elide(record.assetLeg.holdId, 12, 8)}</Mono>} />
            ) : null}
            <Row term="Finalised" value={formatDateTime(settledAt)} />
            {assetTx ? (
              <Row term="Transaction" value={<Mono>{elide(assetTx, 16, 9)}</Mono>} />
            ) : null}
            {assetExplorer ? <Explorer href={assetExplorer} label="Open in HashScan" /> : null}
          </div>

          <div className="bg-raised px-5 py-5">
            <Label className="mb-3">
              Cash leg · {ARC.name} · chain {ARC.chainId}
            </Label>
            <Row term="State" value={trade.cashLeg.state} />
            <Row
              term="Transferred"
              value={`${formatMoney(trade.proceeds)}${record.cashLeg.asset ? ` ${record.cashLeg.asset}` : ''}`}
            />
            {record.cashLeg.from ? (
              <Row term="From" value={<Mono>{elide(record.cashLeg.from, 10, 6)}</Mono>} />
            ) : null}
            {record.cashLeg.to ? (
              <Row term="To" value={<Mono>{elide(record.cashLeg.to, 10, 6)}</Mono>} />
            ) : null}
            {record.cashLeg.network ? <Row term="Network" value={record.cashLeg.network} /> : null}
            <Row term="Finalised" value={formatDateTime(settledAt)} />
            {cashTx ? <Row term="Transaction" value={<Mono>{elide(cashTx, 12, 8)}</Mono>} /> : null}
            {cashExplorer ? <Explorer href={cashExplorer} label="Open in ArcScan" /> : null}
          </div>
        </div>

        {record.settlement ? (
          <div className="border-t border-rule px-5 py-5">
            <Label className="mb-3">What binds them</Label>
            <Row term="Protocol" value={record.settlement.protocol} />
            {record.settlement.facilitator ? (
              <Row term="Facilitator" value={record.settlement.facilitator} />
            ) : null}
            {record.settlement.challengeNonce ? (
              <Row term="Challenge nonce" value={<Mono>{record.settlement.challengeNonce}</Mono>} />
            ) : null}
            {record.settlement.boundAt ? (
              <Row term="Bound at" value={formatDateTime(record.settlement.boundAt)} />
            ) : null}
            <p className="mt-3 text-xs text-muted">{record.settlement.note}</p>
          </div>
        ) : null}
      </Card>

      {record.refusals.length > 0 ? (
        <Card>
          <CardHead
            title="Who was refused, and why"
            hint="Kept for the funders who were told no. A refusal writes a receipt to the same public topic a match does."
          />
          <div className="px-5 py-3">
            {record.refusals.map((refusal) => (
              <div key={`${refusal.mandateId}-${refusal.reasonCode}`} className="ledger-row py-3">
                <p className="text-sm">{refusal.reasonText}</p>
                <p className="mt-1 flex flex-wrap items-center gap-x-3 text-xs text-faint">
                  <span className="num">{refusal.mandateName ?? refusal.mandateId}</span>
                  <span className="num">{refusal.reasonCode}</span>
                  {refusal.hcsExplorerUrl ? (
                    <a
                      href={refusal.hcsExplorerUrl}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="text-accent underline underline-offset-2"
                    >
                      Check the receipt
                    </a>
                  ) : null}
                </p>
              </div>
            ))}
          </div>
        </Card>
      ) : null}

      <Card className="px-5 py-5">
        <Label className="mb-2">Why this ordering matters</Label>
        <p className="max-w-3xl text-sm text-muted">
          An automated market maker matches first and finds out the transfer was not permitted
          afterwards, so a non-compliant trade shows up as a reverted transaction nobody can read.
          Here eligibility is checked against the security&rsquo;s own control list and KYC facets{' '}
          <em>before</em> anything is matched, which is why a refusal in this product is a sentence
          with a reason attached and a receipt anyone can check — not an error.
        </p>
        {record.sellerName || record.buyerName ? (
          <p className="mt-3 text-xs text-faint">
            {record.sellerName ? `Seller ${record.sellerName}` : ''}
            {record.sellerName && record.buyerName ? ' · ' : ''}
            {record.buyerName ? `buyer ${record.buyerName}` : ''}.
          </p>
        ) : null}
      </Card>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function InstrumentCard({ record }: { record: ProofRecord }) {
  const { instrument } = record;

  return (
    <Card>
      <CardHead
        title="The instrument"
        hint="A zero-coupon bond, issued when the invoice was added to the book rather than when it sold — so nobody is waiting on issuance at the moment money moves."
      />
      <div className="px-5 py-4">
        <Row term="Network" value={HEDERA.name} />
        {instrument.tokenId ? <Row term="Token" value={<Mono>{instrument.tokenId}</Mono>} /> : null}
        {instrument.isin ? <Row term="ISIN" value={<Mono>{instrument.isin}</Mono>} /> : null}
        {instrument.uniquenessHash && instrument.uniquenessHash.length > 2 ? (
          <Row
            term="Uniqueness hash"
            value={<Mono>{elide(instrument.uniquenessHash, 12, 8)}</Mono>}
          />
        ) : null}
        {instrument.regulation ? (
          <Row term="Regulation" value={REGULATIONS[instrument.regulation].label} />
        ) : null}
        {instrument.maturity ? (
          <Row term="Maturity" value={formatDate(instrument.maturity)} />
        ) : null}
        <Row term="Coupon" value="None — the discount is the yield" />
        {instrument.issuedAt ? (
          <Row term="Issued" value={formatDateTime(instrument.issuedAt)} />
        ) : null}
        {instrument.explorerUrl ? (
          <Explorer href={instrument.explorerUrl} label="Open the token in HashScan" />
        ) : null}
        {instrument.issuedTxId ? (
          <Explorer
            href={explorerTxUrl(ASSET_CHAIN, instrument.issuedTxId)}
            label="Open the issuance transaction"
          />
        ) : null}
        {!instrument.tokenId ? (
          <p className="mt-3 text-xs text-muted">
            The venue has not published an instrument address for this trade. Nothing is shown here
            that cannot be checked.
          </p>
        ) : null}
      </div>
    </Card>
  );
}

function ComplianceCard({ record }: { record: ProofRecord }) {
  const { compliance } = record;
  const allowed = compliance.allowed;

  return (
    <Card>
      <CardHead
        title="The compliance decision"
        hint="Read before matching, from the security's own control list and KYC facets. Written to a public topic either way."
        right={
          allowed === null ? undefined : (
            <span
              className={[
                'inline-flex h-6 items-center rounded-xs border px-2 text-xs font-medium',
                allowed
                  ? 'border-pos/45 bg-pos-wash text-pos'
                  : 'border-neg/45 bg-neg-wash text-neg',
              ].join(' ')}
            >
              {allowed ? 'Allowed' : 'Refused'}
            </span>
          )
        }
      />
      <div className="px-5 py-4">
        {compliance.checks.length > 0 ? (
          <ul className="mb-4 space-y-2.5">
            {compliance.checks.map((check) => (
              <li key={check.name} className="flex gap-3">
                <span
                  aria-hidden
                  className={`mt-0.5 select-none ${check.passed ? 'text-pos' : 'text-neg'}`}
                >
                  {check.passed ? '✓' : '✕'}
                </span>
                <span className="min-w-0">
                  <span className="block text-sm">{check.name}</span>
                  <span className="block text-xs text-muted">{check.detail}</span>
                </span>
              </li>
            ))}
          </ul>
        ) : null}

        {record.confirmation.decision ? (
          <Row
            term="Customer confirmed"
            value={
              record.confirmation.decidedAt
                ? formatDateTime(record.confirmation.decidedAt)
                : record.confirmation.decision
            }
          />
        ) : null}
        {compliance.checkedAt ? (
          <Row term="Decided" value={formatDateTime(compliance.checkedAt)} />
        ) : null}
        {compliance.hcsTopicId ? (
          <Row term="Receipt topic" value={<Mono>{compliance.hcsTopicId}</Mono>} />
        ) : null}
        {compliance.hcsSequenceNumber ? (
          <Row term="Sequence" value={<Mono>{compliance.hcsSequenceNumber}</Mono>} />
        ) : null}
        {compliance.hcsExplorerUrl ? (
          <Explorer href={compliance.hcsExplorerUrl} label="Read the receipt topic" />
        ) : null}

        {compliance.checkedAt === null && compliance.checks.length === 0 ? (
          <p className="text-sm text-muted">
            The venue has not published a compliance decision for this trade yet.
          </p>
        ) : (
          <p className="mt-3 text-xs text-muted">
            A refusal writes to the same topic. That is what lets a rejected counterparty check the
            decision without trusting the venue that made it.
          </p>
        )}
      </div>
    </Card>
  );
}

/* -------------------------------------------------------------------------- */

function Summary({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="bg-raised px-5 py-4">
      <Label>{label}</Label>
      <div className="num mt-1.5 text-lg leading-none" data-num>
        {value}
      </div>
      <div className="mt-1.5 text-xs text-muted">{note}</div>
    </div>
  );
}

function Step({
  n,
  title,
  at,
  note,
}: {
  n: number;
  title: string;
  at: string | null;
  note: string;
}) {
  return (
    <li className="bg-raised px-4 py-3.5">
      <span className="label-micro">Step {n}</span>
      <span className="mt-1 block text-sm">{title}</span>
      <span className="num mt-1 block text-xs text-muted" data-num>
        {at === null ? 'not published' : formatDateTime(at)}
      </span>
      <span className="mt-0.5 block text-xs text-faint">{note}</span>
    </li>
  );
}

function Mono({ children }: { children: ReactNode }) {
  return <span className="num text-xs">{children}</span>;
}

function Explorer({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="mt-3 inline-flex items-center gap-1.5 text-xs text-accent underline underline-offset-2 hover:text-accent-ink"
    >
      {label}
      <span aria-hidden>↗</span>
    </a>
  );
}

function secondsBetween(from: string, to: string): number {
  return Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 1000));
}
