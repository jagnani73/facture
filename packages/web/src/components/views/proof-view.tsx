import Link from 'next/link';
import type { ReactNode } from 'react';

import { ASSET_CHAIN, CASH_CHAIN, CHAINS, REGULATIONS, explorerTxUrl } from '@/lib/domain';
import { elide, formatDate, formatDateTime, formatMoney, formatRate } from '@/lib/format';
import type { TradeProof } from '@/lib/fixtures';
import { debtorNameOf, getInvoice, getTrade, getTradeProof, metaOf, seller } from '@/lib/fixtures';
import { Card, CardHead, Label, PageHeader, Row, buttonClasses } from '@/components/ui/primitives';

/**
 * The proof view.
 *
 * This is the one screen in Facture where the machinery is named. Everywhere else a buyer
 * sees exposure and yield and a seller sees a price, because every primitive in this
 * market already has a plain financial name. Here, one click from any trade, the receipts
 * are shown as they are — with the identifiers to check them somewhere that is not this
 * website.
 */

const HEDERA = CHAINS[ASSET_CHAIN];
const ARC = CHAINS[CASH_CHAIN];

export function ProofView({ tradeId }: { tradeId: string }) {
  const trade = getTrade(tradeId);
  const proof = getTradeProof(tradeId);

  if (!trade || !proof) {
    return (
      <Card className="px-6 py-10 text-center">
        <p className="text-sm text-muted">No settled trade with that reference.</p>
        <Link href="/book" className={`${buttonClasses('secondary')} mt-4`}>
          Back to the book
        </Link>
      </Card>
    );
  }

  const invoice = getInvoice(trade.invoiceId);
  const meta = metaOf(trade.mandateId);
  const settledAt = trade.settledAt ?? trade.executedAt;

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow={`Trade ${trade.id}`}
        title="Proof of settlement"
        lede="Every other screen here is a market, in ordinary financial language. This one shows the machinery, because a claim about settlement is worth nothing if you cannot check it somewhere that is not us."
        actions={
          invoice ? (
            <Link href={`/book/${invoice.id}`} className={buttonClasses('secondary')}>
              Back to the invoice
            </Link>
          ) : undefined
        }
      />

      <Card className="grid gap-px bg-rule sm:grid-cols-4">
        <Summary
          label="Invoice"
          value={invoice?.invoiceNumber ?? trade.invoiceId}
          note={invoice ? debtorNameOf(invoice) : ''}
        />
        <Summary
          label="Face at maturity"
          value={formatMoney(trade.faceValue, { fractionDigits: 0 })}
          note={`due ${formatDate(proof.instrument.maturity)}`}
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
          at={proof.instrument.issuedAt}
          note="At onboarding, not at sale"
        />
        <Step
          n={2}
          title="Checked"
          at={proof.compliance.checkedAt}
          note="Before matching, not after"
        />
        <Step n={3} title="Matched" at={trade.executedAt} note={meta.name} />
        <Step n={4} title="Bound" at={proof.settlement.boundAt} note="Both legs, one nonce" />
        <Step n={5} title="Settled" at={settledAt} note="Delivery versus payment" />
      </ol>

      <div className="grid gap-6 lg:grid-cols-2">
        <InstrumentCard proof={proof} />
        <ComplianceCard proof={proof} />
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
            <Row term="Transferred" value={proof.assetLeg.quantity} />
            <Row term="From" value={<Mono>{proof.assetLeg.from}</Mono>} />
            <Row term="To" value={<Mono>{proof.assetLeg.to}</Mono>} />
            <Row term="Finalised" value={formatDateTime(settledAt)} />
            <Row
              term="Transaction"
              value={<Mono>{elide(trade.assetLeg.reference ?? '—', 16, 9)}</Mono>}
            />
            {trade.assetLeg.reference ? (
              <Explorer
                href={explorerTxUrl(ASSET_CHAIN, trade.assetLeg.reference)}
                label="Open in HashScan"
              />
            ) : null}
          </div>

          <div className="bg-raised px-5 py-5">
            <Label className="mb-3">
              Cash leg · {ARC.name} · chain {ARC.chainId}
            </Label>
            <Row term="State" value={trade.cashLeg.state} />
            <Row
              term="Transferred"
              value={`${formatMoney(trade.proceeds)} ${proof.cashLeg.asset}`}
            />
            <Row term="From" value={<Mono>{elide(proof.cashLeg.from, 10, 6)}</Mono>} />
            <Row term="To" value={<Mono>{elide(proof.cashLeg.to, 10, 6)}</Mono>} />
            <Row term="Finalised" value={formatDateTime(settledAt)} />
            <Row
              term="Transaction"
              value={<Mono>{elide(trade.cashLeg.reference ?? '—', 12, 8)}</Mono>}
            />
            {trade.cashLeg.reference ? (
              <Explorer
                href={explorerTxUrl(CASH_CHAIN, trade.cashLeg.reference)}
                label="Open in ArcScan"
              />
            ) : null}
          </div>
        </div>

        <div className="border-t border-rule px-5 py-5">
          <Label className="mb-3">What binds them</Label>
          <Row term="Protocol" value={proof.settlement.protocol} />
          <Row term="Facilitator" value={proof.settlement.facilitator} />
          <Row term="Challenge nonce" value={<Mono>{proof.settlement.challengeNonce}</Mono>} />
          <Row term="Bound at" value={formatDateTime(proof.settlement.boundAt)} />
          <p className="mt-3 text-xs text-muted">{proof.settlement.note}</p>
        </div>
      </Card>

      <Card className="px-5 py-5">
        <Label className="mb-2">Why this ordering matters</Label>
        <p className="max-w-3xl text-sm text-muted">
          An automated market maker matches first and finds out the transfer was not permitted
          afterwards, so a non-compliant trade shows up as a reverted transaction nobody can read.
          Here eligibility is checked against the security&rsquo;s own control list and KYC facets{' '}
          <em>before</em> anything is matched, which is why a refusal in this product is a sentence
          with a reason attached and a receipt anyone can check — not an error.
        </p>
        <p className="mt-3 text-xs text-faint">
          Seller {seller.name} · buyer {meta.ownerName}. Testnet identifiers, demo data.
        </p>
      </Card>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function InstrumentCard({ proof }: { proof: TradeProof }) {
  return (
    <Card>
      <CardHead
        title="The instrument"
        hint="A zero-coupon bond, issued when the invoice was added to the book rather than when it sold — so nobody is waiting on issuance at the moment money moves."
      />
      <div className="px-5 py-4">
        <Row term="Network" value={HEDERA.name} />
        <Row term="Token" value={<Mono>{proof.instrument.tokenId}</Mono>} />
        <Row term="ISIN" value={<Mono>{proof.instrument.isin}</Mono>} />
        <Row term="Regulation" value={REGULATIONS[proof.instrument.regulation].label} />
        <Row term="Maturity" value={formatDate(proof.instrument.maturity)} />
        <Row term="Coupon" value="None — the discount is the yield" />
        <Row term="Issued" value={formatDateTime(proof.instrument.issuedAt)} />
        <Explorer
          href={`${HEDERA.explorerUrl}/token/${proof.instrument.tokenId}`}
          label="Open the token in HashScan"
        />
        <Explorer
          href={explorerTxUrl(ASSET_CHAIN, proof.instrument.issuedTxId)}
          label="Open the issuance transaction"
        />
      </div>
    </Card>
  );
}

function ComplianceCard({ proof }: { proof: TradeProof }) {
  const allowed = proof.compliance.decision === 'allowed';

  return (
    <Card>
      <CardHead
        title="The compliance decision"
        hint="Read before matching, from the security's own control list and KYC facets. Written to a public topic either way."
        right={
          <span
            className={[
              'inline-flex h-6 items-center rounded-xs border px-2 text-xs font-medium',
              allowed ? 'border-pos/45 bg-pos-wash text-pos' : 'border-neg/45 bg-neg-wash text-neg',
            ].join(' ')}
          >
            {allowed ? 'Allowed' : 'Refused'}
          </span>
        }
      />
      <div className="px-5 py-4">
        <ul className="mb-4 space-y-2.5">
          {proof.compliance.checks.map((check) => (
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

        <Row term="Decided" value={formatDateTime(proof.compliance.checkedAt)} />
        <Row term="Receipt topic" value={<Mono>{proof.compliance.receiptTopicId}</Mono>} />
        <Row term="Sequence" value={<Mono>{String(proof.compliance.receiptSequence)}</Mono>} />
        <Row term="Consensus" value={<Mono>{proof.compliance.consensusTimestamp}</Mono>} />
        <Explorer
          href={`${HEDERA.explorerUrl}/topic/${proof.compliance.receiptTopicId}`}
          label="Read the receipt topic"
        />
        <p className="mt-3 text-xs text-muted">
          A refusal writes to the same topic. That is what lets a rejected counterparty check the
          decision without trusting the venue that made it.
        </p>
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

function Step({ n, title, at, note }: { n: number; title: string; at: string; note: string }) {
  return (
    <li className="bg-raised px-4 py-3.5">
      <span className="label-micro">Step {n}</span>
      <span className="mt-1 block text-sm">{title}</span>
      <span className="num mt-1 block text-xs text-muted" data-num>
        {formatDateTime(at)}
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
