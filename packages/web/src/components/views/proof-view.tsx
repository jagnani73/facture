'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';

import type { SettlementLegState } from '@/lib/domain';
import { ASSET_CHAIN, CASH_CHAIN, CHAINS, REGULATIONS, explorerTxUrl } from '@/lib/domain';
import {
  elide,
  formatDate,
  formatDateTime,
  formatMoney,
  formatRate,
  formatUsdc,
} from '@/lib/format';
import type { CashRail } from '@/lib/api/contract';
import type { ProofRecord } from '@/lib/data';
import { useProof } from '@/lib/data/hooks';
import {
  SETTLEMENT_STATE_LABEL,
  SETTLEMENT_STATE_SENTENCE,
  halfSettledLegs,
  settlementStateOf,
} from '@/lib/settlement';
import { ClaimPayout } from '@/components/claim-payout';
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

/**
 * How each rail is named on the page.
 *
 * Spelled out rather than printed raw, because `arc-vault` is an identifier and this is the
 * screen a funder reads to understand what happened. The distinction the words carry is the
 * whole point: one rail took a signature for this trade, the other did not need one.
 */
const RAIL_LABEL: Record<CashRail, string> = {
  x402: 'x402 \u2014 signed for this trade',
  'arc-vault': 'Escrowed capital \u2014 no signature needed',
};

function Proof({ record }: { record: ProofRecord }) {
  const { trade } = record;
  const state = settlementStateOf(trade);
  const complete = state === 'settled';
  /*
   * Only a settled trade has a settlement date, and the legs are what decide that — not
   * the timestamp. The venue leaves `settledAt` populated on a trade it later marks
   * `failed`, so a half-settled trade arrives carrying the moment it *would* have settled.
   * Printing that under the word "Settled" would be the page asserting the one thing it
   * exists to let a reader check for themselves.
   */
  const settledAt = complete ? (record.settledAt ?? trade.settledAt ?? null) : null;

  /*
   * The cash leg is not always Arc. This deployment settles it in HBAR through the
   * facilitator, so the venue answers `hedera:testnet` — and labelling the panel "Arc" or
   * building an ArcScan link over a Hedera transaction id would be a dead link on the one
   * screen whose entire job is being checkable somewhere that is not us.
   */
  const cashChain = CHAINS[record.cashLeg.chain];
  const cashChainId = 'chainId' in cashChain ? cashChain.chainId : null;
  const cashExplorerName = record.cashLeg.chain === ASSET_CHAIN ? 'HashScan' : 'ArcScan';

  const assetTx = record.assetLeg.transactionId ?? trade.assetLeg.reference ?? null;
  const cashTx = record.cashLeg.transaction ?? trade.cashLeg.reference ?? null;
  const assetExplorer =
    record.assetLeg.explorerUrl ?? (assetTx ? explorerTxUrl(ASSET_CHAIN, assetTx) : null);
  const cashExplorer =
    record.cashLeg.explorerUrl ?? (cashTx ? explorerTxUrl(record.cashLeg.chain, cashTx) : null);

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow={`Trade ${trade.id}`}
        title={complete ? 'Proof of settlement' : 'Both legs of this trade'}
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

      {complete ? null : <SettlementBanner record={record} />}

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
          label={complete ? 'Paid to the seller' : 'Price this trade was struck at'}
          value={formatMoney(trade.proceeds)}
          note={`${formatRate(trade.annualisedYieldBps)} over ${trade.tenorDays} days`}
        />
        {/* No settlement date is invented for a trade that has not settled. */}
        <Summary
          label={complete ? 'Settled' : SETTLEMENT_STATE_LABEL[state]}
          value={settledAt === null ? '—' : formatDate(settledAt)}
          note={
            settledAt === null
              ? `matched ${formatDate(trade.executedAt)}`
              : `${secondsBetween(trade.executedAt, settledAt)}s after the match`
          }
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
        <Step
          n={5}
          title={complete ? 'Settled' : SETTLEMENT_STATE_LABEL[state]}
          at={settledAt}
          note={complete ? 'Delivery versus payment' : 'Not both legs'}
        />
      </ol>

      <div className="grid gap-6 lg:grid-cols-2">
        <InstrumentCard record={record} />
        <ComplianceCard record={record} />
      </div>

      <Card>
        {/*
          The hint names the chain the cash leg actually settled on rather than asserting
          Arc. The claim being made is that nothing crossed and nothing was wrapped, and
          that claim is weaker, not stronger, if the page is wrong about where the money is
          — including when both legs happen to land on the same ledger, which is what a
          deployment settling in HBAR rather than USDC on Arc looks like.
        */}
        <CardHead
          title="Both legs of the settlement"
          /*
             The sentence follows the RAIL, not the chain.

             It used to branch on whether the cash leg was on Hedera, and both branches ended
             "bound to one challenge" — which is true of x402 and false of a vault payout,
             where the buyer escrowed the capital in advance and signed nothing. On the rail
             that most needs explaining, the page was describing a mechanism that did not run.
          */
          hint={
            record.cashLeg.rail === 'arc-vault'
              ? `The paper never left ${HEDERA.name} and the cash never left ${cashChain.name}. There is no bridge here and nothing is wrapped: the buyer escrowed this capital before the invoice existed, so there was nothing to sign, and the payout is locked against the same hash the paper moved under.`
              : record.cashLeg.chain === ASSET_CHAIN
                ? `Both legs settled on ${HEDERA.name}: this deployment takes the cash leg in HBAR through the x402 facilitator rather than USDC on Arc. Nothing is wrapped and nothing crosses — the two legs are bound to one challenge, so neither can settle without the other.`
                : `The paper never left ${HEDERA.name} and the cash never left ${cashChain.name}. There is no bridge here and nothing is wrapped — the two legs are bound to one challenge, so neither can settle without the other.`
          }
        />

        <div className="grid gap-px bg-rule md:grid-cols-2">
          <div className="bg-raised px-5 py-5">
            <Label className="mb-3">Asset leg · {HEDERA.name}</Label>
            <Row term="State" value={<LegState state={trade.assetLeg.state} />} />
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
            {/*
              A leg that did not settle has no finalised moment. It does have a last known
              consensus timestamp — the hold going on — and that is what it is called.
            */}
            {(record.assetLeg.consensusAt ??
            (trade.assetLeg.state === 'settled' ? settledAt : null)) ? (
              <Row
                term={trade.assetLeg.state === 'settled' ? 'Finalised' : 'Last consensus'}
                value={formatDateTime(record.assetLeg.consensusAt ?? settledAt ?? trade.executedAt)}
              />
            ) : null}
            {assetTx ? (
              <Row term="Transaction" value={<Mono>{elide(assetTx, 16, 9)}</Mono>} />
            ) : null}
            {assetExplorer ? <Explorer href={assetExplorer} label="Open in HashScan" /> : null}
          </div>

          <div className="bg-raised px-5 py-5">
            {/*
              The chain is named only once a rail has run.

              The venue answers `chain: null` for a cash leg that has not settled, and the
              decoder's fallback turns that into Arc — a reasonable display default, but on
              this page it reads as a claim that the money is going to a specific chain when
              the venue has not said so. An unsettled leg gets the plain label instead.
            */}
            <Label className="mb-3">
              {record.cashLeg.rail === null && trade.cashLeg.state === 'pending'
                ? 'Cash leg'
                : `Cash leg · ${cashChain.name}${cashChainId === null ? '' : ` · chain ${cashChainId}`}`}
            </Label>
            <Row term="State" value={<LegState state={trade.cashLeg.state} />} />
            {record.cashLeg.rail ? (
              <Row term="Rail" value={RAIL_LABEL[record.cashLeg.rail]} />
            ) : null}
            <Row
              term={trade.cashLeg.state === 'settled' ? 'Transferred' : 'To transfer'}
              value={`${formatMoney(trade.proceeds)}${record.cashLeg.asset ? ` ${record.cashLeg.asset}` : ''}`}
            />
            {/*
              The figure that matches the transaction. The row above is the invoice price in
              dollars; this is what actually moved, in the settlement asset's own units, and
              the two differ by the venue's testnet scale. A reader checking the explorer sees
              this number, so a page showing only the first reads as a discrepancy.
            */}
            {record.cashLeg.settledAmountMinor === null ? null : (
              <Row
                term="Settled amount"
                value={
                  record.cashLeg.rail === 'arc-vault'
                    ? formatUsdc(record.cashLeg.settledAmountMinor)
                    : `${record.cashLeg.settledAmountMinor.toString(10)}${
                        record.cashLeg.asset ? ` (${record.cashLeg.asset})` : ''
                      }`
                }
              />
            )}
            {record.cashLeg.from ? (
              <Row term="From" value={<Mono>{elide(record.cashLeg.from, 10, 6)}</Mono>} />
            ) : null}
            {record.cashLeg.to ? (
              <Row term="To" value={<Mono>{elide(record.cashLeg.to, 10, 6)}</Mono>} />
            ) : null}
            {record.cashLeg.network ? <Row term="Network" value={record.cashLeg.network} /> : null}
            {trade.cashLeg.state === 'settled' ? (
              <Row term="Finalised" value={formatDateTime(settledAt ?? trade.executedAt)} />
            ) : null}
            {cashTx ? <Row term="Transaction" value={<Mono>{elide(cashTx, 12, 8)}</Mono>} /> : null}
            {cashExplorer ? (
              <Explorer href={cashExplorer} label={`Open in ${cashExplorerName}`} />
            ) : null}
          </div>

          {/*
            Where the money actually is.

            A vault payout is locked in an escrow claimable by the seller alone, for a day -
            it is not in their wallet. Reporting the cash leg as settled and stopping there
            would tell a seller they have been paid before anyone moved the money to them,
            which is the one thing this page exists not to do.
          */}
          {record.cashLeg.lock === null ? null : (
            <div className="bg-raised px-5 py-5">
              <Label className="mb-3">Payout escrow · {CHAINS[CASH_CHAIN].name}</Label>
              <Row
                term="State"
                value={
                  record.cashLeg.lock.status === 'claimed' ? (
                    <span className="text-pos">Seller has taken the payout</span>
                  ) : record.cashLeg.lock.status === 'locked' ? (
                    <span className="text-muted">Locked for the seller, not yet claimed</span>
                  ) : record.cashLeg.lock.status === 'refunded' ? (
                    <span className="text-muted">Unclaimed; returned to the buyer</span>
                  ) : (
                    <span className="text-muted">The escrow could not be read just now</span>
                  )
                }
              />
              <Row term="Lock" value={<Mono>{elide(record.cashLeg.lock.lockId, 12, 8)}</Mono>} />
              {record.cashLeg.lock.beneficiary ? (
                <Row
                  term="Claimable by"
                  value={<Mono>{elide(record.cashLeg.lock.beneficiary, 10, 6)}</Mono>}
                />
              ) : null}
              {record.cashLeg.lock.amountMinor === null ? null : (
                <Row term="Held" value={formatUsdc(record.cashLeg.lock.amountMinor)} />
              )}
              {record.cashLeg.lock.claimableUntil ? (
                <Row
                  term="Claimable until"
                  value={formatDateTime(record.cashLeg.lock.claimableUntil)}
                />
              ) : null}
              {record.cashLeg.lock.explorerUrl ? (
                <Explorer href={record.cashLeg.lock.explorerUrl} label="Open in ArcScan" />
              ) : null}
              {/*
                Renders only for the seller whose wallet IS the beneficiary — the component
                returns null for everyone else, because `claim` checks the caller and
                offering a button that reverts is worse than offering none.
              */}
              <ClaimPayout lock={record.cashLeg.lock} />
            </div>
          )}
        </div>

        {/*
         * Maturity — the third receipt, and the one that makes a resale legitimate. Absent
         * entirely until the receivable has matured, because a block saying "not yet" on
         * every trade in the book would be noise on the one screen that has to stay
         * readable.
         *
         * The two states are kept visibly apart. A scheduled payout is an obligation
         * sitting on the ledger, not money that moved; it becomes a payment when the venue
         * signs that the debtor's money arrived. Collapsing them here would put a receipt
         * on screen for a transfer nobody had made.
         */}
        {record.payout ? (
          <div className="border-t border-rule px-5 py-5">
            <Label className="mb-3">Maturity · {HEDERA.name}</Label>
            <Row
              term="State"
              value={
                record.payout.state === 'settled' ? (
                  <span className="text-pos">Holder paid at par</span>
                ) : (
                  <span className="text-muted">Obligation on the ledger, not yet signed</span>
                )
              }
            />
            <Row
              term={record.payout.state === 'settled' ? 'Paid' : 'Payable'}
              value={formatMoney(trade.faceValue)}
            />
            <Row term="Schedule" value={<Mono>{elide(record.payout.scheduleId, 12, 8)}</Mono>} />
            {record.payout.payer ? (
              <Row term="From" value={<Mono>{elide(record.payout.payer, 10, 6)}</Mono>} />
            ) : null}
            {record.payout.payee ? (
              <Row term="To" value={<Mono>{elide(record.payout.payee, 10, 6)}</Mono>} />
            ) : null}
            {record.payout.executedAt ? (
              <Row term="Paid at" value={formatDateTime(record.payout.executedAt)} />
            ) : null}
            {record.payout.transactionId ? (
              <Row
                term="Transaction"
                value={<Mono>{elide(record.payout.transactionId, 12, 8)}</Mono>}
              />
            ) : null}
            {record.payout.explorerUrl ? (
              <Explorer href={record.payout.explorerUrl} label="Open the payment in HashScan" />
            ) : record.payout.scheduleExplorerUrl ? (
              <Explorer
                href={record.payout.scheduleExplorerUrl}
                label="Open the obligation in HashScan"
              />
            ) : null}
          </div>
        ) : null}

        {record.settlement ? (
          <div className="border-t border-rule px-5 py-5">
            <Label className="mb-3">What binds them</Label>
            <Row term="Protocol" value={record.settlement.protocol} />
            {/* `exact` is the x402 scheme the payer signed under. It is not the protocol. */}
            {record.settlement.scheme ? (
              <Row term="Scheme" value={record.settlement.scheme} />
            ) : null}
            {record.settlement.network ? (
              <Row term="Network" value={record.settlement.network} />
            ) : null}
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
              <div
                key={`${refusal.mandateId}-${refusal.reasonCode}-${refusal.reasonText}`}
                className="ledger-row py-3"
              >
                <p className="text-sm">{refusal.reasonText}</p>
                <p className="mt-1 flex flex-wrap items-center gap-x-3 text-xs text-faint">
                  <span className="num">{refusal.mandateName ?? refusal.mandateId}</span>
                  <span className="num">{refusal.reasonCode}</span>
                  {/* Said once, with the number of times the venue wrote it down. */}
                  {refusal.times > 1 ? (
                    <span className="num">recorded {refusal.times}×</span>
                  ) : null}
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

/**
 * What happened to a trade that is not a settled one.
 *
 * A half-settled trade gets the strongest treatment on this screen and the only one drawn
 * in the negative colour, because it is the only state where **money moved and the paper
 * did not**. The venue records it loudly and refuses to unwind it: releasing a hold against
 * a payment that actually happened turns a state that can be reconciled into one that
 * cannot. So the page says the payment went through, names the leg that did not, and hands
 * over the id to quote — rather than leaving a reader to infer from two state words in a
 * table that they have paid for nothing.
 */
function SettlementBanner({ record }: { record: ProofRecord }) {
  const state = settlementStateOf(record.trade);
  const half = state === 'half_settled';
  const legs = halfSettledLegs(record.trade);

  return (
    <Card
      className={half ? 'border-2 border-neg/50 bg-neg-wash px-5 py-5' : 'px-5 py-5'}
      role={half ? 'alert' : undefined}
    >
      <Label className="mb-1">
        {half ? 'The payment went through — the paper did not' : SETTLEMENT_STATE_LABEL[state]}
      </Label>
      <p className="max-w-3xl text-sm text-ink">{SETTLEMENT_STATE_SENTENCE[state]}</p>
      {half ? (
        <p className="mt-2 max-w-3xl text-sm text-muted">
          The {legs.moved === 'cash' ? 'cash' : 'asset'} leg below carries a real transaction you
          can open on an explorer; the {legs.stalled === 'asset' ? 'asset' : 'cash'} leg does not,
          and that difference is the whole of what went wrong. Quote{' '}
          <span className="num">{record.tradeId}</span> when asking about it.
        </p>
      ) : null}
    </Card>
  );
}

/** A leg state in the same desaturated vocabulary the rest of the page uses. */
function LegState({ state }: { state: SettlementLegState }) {
  const tone =
    state === 'settled'
      ? 'text-pos'
      : state === 'failed'
        ? 'text-neg'
        : state === 'held'
          ? 'text-accent'
          : 'text-muted';
  return <span className={tone}>{state}</span>;
}

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
          <Explorer href={instrument.explorerUrl} label="Open the security in HashScan" />
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
        {/*
          The refusal in words, above the checklist rather than buried in it. A funder told
          no is owed the sentence, and it is the same sentence the receipt carries.
        */}
        {compliance.allowed === false && compliance.reason ? (
          <p className="mb-4 rounded-sm border border-rule bg-sunken px-4 py-3 text-sm text-ink">
            {compliance.reason}
          </p>
        ) : null}

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

        <RegistryBlock record={record} />

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

/**
 * What the chain says about this invoice, beside what the venue says.
 *
 * `InvoiceRegistry.isConfirmed(invoiceId)` is a public view, and that is the whole point of
 * this block: it moves "the customer acknowledged this" from a column only the venue can see
 * to something a reader can call for themselves. The acknowledgement is what justifies
 * advancing the full face value with no holdback, so it is the claim on this page most worth
 * checking somewhere that is not us.
 *
 * **Three states per answer, never two.** `checked: false` is a question that went
 * unanswered — no registry configured for this deployment, or a node that could not be read
 * — and it renders as that rather than as a no. A registry blinking would otherwise print
 * "not confirmed" one line under a confirmation the venue is certain of.
 */
function RegistryBlock({ record }: { record: ProofRecord }) {
  const { registry } = record;

  /*
   * A disagreement is shown, not resolved. The venue's column and the public view are two
   * parties answering one question; if they differ, that is the reader's to weigh. Picking
   * one would leave the stronger-looking claim standing alone, which is the failure this
   * whole screen is built against.
   */
  const contradicted =
    registry.confirmed !== null &&
    record.confirmation.decision !== null &&
    registry.confirmed !== (record.confirmation.decision === 'confirmed');

  // Bounded top and bottom, because the rows either side of it come from the venue.
  return (
    <div className="my-4 border-y border-rule py-3">
      <Label className="mb-1">The public invoice registry</Label>

      {registry.checked ? (
        <>
          <Row term="Listed on chain" value={<OnChain answer={registry.listed} />} />
          <Row term="Confirmed on chain" value={<OnChain answer={registry.confirmed} />} />
        </>
      ) : (
        <p className="py-2 text-xs text-muted">
          Not asked. Either no registry is configured for this deployment, or the node could not be
          read — so nothing here is the chain&rsquo;s answer about this invoice, which is not the
          same as the chain answering no.
        </p>
      )}

      {registry.contractAddress ? (
        <Row term="Registry" value={<Mono>{elide(registry.contractAddress, 10, 8)}</Mono>} />
      ) : null}

      {contradicted ? (
        <p className="mt-2 rounded-sm border border-rule bg-sunken px-3 py-2 text-xs text-ink">
          The registry and the venue&rsquo;s own record disagree about this invoice. Both are shown
          exactly as they were read, and neither is corrected here.
        </p>
      ) : null}

      {/* No identifier, no link. A dead explorer link claims more than an absent one. */}
      {registry.explorerUrl ? (
        <Explorer href={registry.explorerUrl} label="Open the registry contract" />
      ) : null}
    </div>
  );
}

/**
 * One registry answer, in three states.
 *
 * `null` is "not answered" and is deliberately not styled as a refusal: a question the venue
 * could not put to the node is not the node saying no.
 */
function OnChain({ answer }: { answer: boolean | null }) {
  if (answer === null) return <span className="text-muted">Not answered</span>;
  return <span className={answer ? 'text-pos' : 'text-neg'}>{answer ? 'Yes' : 'No'}</span>;
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
