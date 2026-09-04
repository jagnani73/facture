'use client';

import type { ReactNode } from 'react';
import { useState } from 'react';

import { formatDateProse, formatMoney } from '@/lib/format';
import type { ConfirmationRecord } from '@/lib/data';
import { answerConfirmation } from '@/lib/data';
import { useConfirmation } from '@/lib/data/hooks';
import { describeFailure } from '@/lib/api/problem';
import { Button } from '@/components/ui/primitives';

/**
 * The debtor confirmation page.
 *
 * One sentence and two buttons. No account, no wallet, no software, no jargon, and nothing
 * on the screen that reveals what is underneath — because the person reading it is not a
 * customer of this market, they are somebody's accounts payable clerk being asked about
 * their own ledger.
 *
 * This works for a behavioural reason rather than a cryptographic one: they are not
 * vouching for a stranger, they are acknowledging a bill they already know about, which
 * costs them nothing and which they have no reason to deny.
 *
 * **Nothing about the market may appear here.** No masthead, no navigation, no bid, no
 * rate, no proceeds, no buyer. The route deliberately sits outside the `(app)` group so it
 * cannot inherit the chrome, and the record this page reads
 * (`ConfirmationRecord`) deliberately has no price on it, so there is nothing to leak even
 * by accident. Every state below — loading, failed, expired, answered — renders inside the
 * same bare shell, because a page that stays clean only on the happy path is not clean.
 */

const PROBLEMS = [
  'The amount is different',
  'We have already paid this',
  'The due date is different',
  'We did not order this',
] as const;

type Answer = 'unanswered' | 'confirming' | 'confirmed' | 'querying' | 'submitting' | 'queried';

export function ConfirmView({ token }: { token: string }) {
  const confirmation = useConfirmation(token);

  if (confirmation.status === 'loading') {
    return (
      <Shell>
        <p className="text-lg text-muted">Fetching the invoice you were sent…</p>
      </Shell>
    );
  }

  if (confirmation.status === 'failed') {
    return (
      <Shell>
        <p className="font-serif text-2xl leading-snug">We could not open this link.</p>
        <p className="mt-4 text-sm text-muted">
          {describeFailure(confirmation.error, 'this invoice')}
        </p>
        <p className="mt-3 text-sm text-muted">
          Nothing is expected of you in the meantime. If you were asked to check an invoice, ask the
          sender to send it again.
        </p>
        <button
          type="button"
          onClick={confirmation.reload}
          className="mt-5 text-xs text-muted underline underline-offset-2 hover:text-ink"
        >
          Try again
        </button>
      </Shell>
    );
  }

  if (confirmation.data === null) {
    return (
      <Shell>
        <p className="text-lg">This link has expired.</p>
        <p className="mt-3 text-sm text-muted">
          If you were asked to check an invoice, ask the sender to send a fresh link. There is
          nothing you need to do here.
        </p>
      </Shell>
    );
  }

  return <Prompt token={token} record={confirmation.data} />;
}

function Prompt({ token, record }: { token: string; record: ConfirmationRecord }) {
  const [answer, setAnswer] = useState<Answer>(
    record.decision === 'confirmed'
      ? 'confirmed'
      : record.decision === 'disputed'
        ? 'queried'
        : 'unanswered',
  );
  const [problem, setProblem] = useState<string>('');
  const [failure, setFailure] = useState<string | null>(null);

  const seller = record.sellerName;

  async function send(decision: 'confirmed' | 'disputed', note?: string) {
    setFailure(null);
    setAnswer(decision === 'confirmed' ? 'confirming' : 'submitting');
    const result = await answerConfirmation(token, decision, note);
    if (result.ok) {
      setAnswer(decision === 'confirmed' ? 'confirmed' : 'queried');
    } else {
      setFailure(result.reason);
      setAnswer(decision === 'confirmed' ? 'unanswered' : 'querying');
    }
  }

  if (answer === 'confirmed') {
    return (
      <Shell seller={seller}>
        <p className="font-serif text-2xl leading-snug">Thank you — that is all we needed.</p>
        <p className="mt-4 text-sm text-muted">
          Nothing about this invoice has changed. You still pay {seller} the same amount, on{' '}
          {formatDateProse(record.dueAt)}, in the same way you always have.
        </p>
        <p className="mt-3 text-sm text-muted">You can close this page.</p>
      </Shell>
    );
  }

  if (answer === 'queried') {
    return (
      <Shell seller={seller}>
        <p className="font-serif text-2xl leading-snug">We have told {seller}.</p>
        <p className="mt-4 text-sm text-muted">
          {problem === '' ? 'They' : `We passed on that ${problem.toLowerCase()}, and they`} will be
          in touch with you directly. Nothing happens to this invoice in the meantime.
        </p>
        <p className="mt-3 text-sm text-muted">You can close this page.</p>
      </Shell>
    );
  }

  if (answer === 'querying' || answer === 'submitting') {
    return (
      <Shell seller={seller}>
        <p className="font-serif text-2xl leading-snug">What is not right?</p>
        <div className="mt-6 space-y-2">
          {PROBLEMS.map((option) => (
            <button
              key={option}
              type="button"
              disabled={answer === 'submitting'}
              onClick={() => {
                setProblem(option);
                void send('disputed', option);
              }}
              className="block w-full rounded-sm border border-rule bg-raised px-4 py-3 text-left text-sm transition-colors hover:border-accent hover:text-accent disabled:opacity-60"
            >
              {option}
            </button>
          ))}
        </div>
        {failure ? <p className="mt-4 text-sm text-warn">{failure}</p> : null}
        <button
          type="button"
          onClick={() => setAnswer('unanswered')}
          className="mt-5 text-xs text-muted underline underline-offset-2 hover:text-ink"
        >
          Go back
        </button>
      </Shell>
    );
  }

  return (
    <Shell seller={seller}>
      <p className="font-serif text-[1.75rem] leading-snug sm:text-[2rem]">
        {seller} says you owe them{' '}
        <span className="num whitespace-nowrap" data-num>
          {record.faceValue === null
            ? record.amount
            : formatMoney(record.faceValue, { fractionDigits: 0 })}
        </span>
        , due {formatDateProse(record.dueAt)}.
      </p>
      <p className="mt-4 text-lg">Is that right?</p>

      <div className="mt-8 flex flex-col gap-3 sm:flex-row">
        <Button
          variant="primary"
          size="lg"
          disabled={answer === 'confirming'}
          onClick={() => void send('confirmed')}
        >
          {answer === 'confirming' ? 'Sending…' : 'Yes, that is right'}
        </Button>
        <Button size="lg" disabled={answer === 'confirming'} onClick={() => setAnswer('querying')}>
          No, something is wrong
        </Button>
      </div>

      {failure ? <p className="mt-4 text-sm text-warn">{failure}</p> : null}

      <dl className="mt-10 border-t border-rule pt-5 text-sm">
        {record.invoiceNumber ? (
          <div className="flex justify-between gap-6 py-1.5">
            <dt className="text-muted">Invoice</dt>
            <dd className="num">{record.invoiceNumber}</dd>
          </div>
        ) : null}
        <div className="flex justify-between gap-6 py-1.5">
          <dt className="text-muted">From</dt>
          <dd>{seller}</dd>
        </div>
        {record.debtorName ? (
          <div className="flex justify-between gap-6 py-1.5">
            <dt className="text-muted">To</dt>
            <dd>{record.debtorName}</dd>
          </div>
        ) : null}
        <div className="flex justify-between gap-6 py-1.5">
          <dt className="text-muted">Amount</dt>
          <dd className="num">{record.amount}</dd>
        </div>
        <div className="flex justify-between gap-6 py-1.5">
          <dt className="text-muted">Due</dt>
          <dd className="num">{formatDateProse(record.dueAt)}</dd>
        </div>
      </dl>

      <p className="mt-6 text-xs text-muted">
        Saying yes does not commit you to paying any earlier, and it does not sign you up to
        anything. It confirms the amount and the date are the ones on your own ledger.
      </p>
    </Shell>
  );
}

/**
 * The whole page. One column, no header, no navigation, no footer links into the market.
 * Every state above renders through here, so there is no path that grows chrome.
 */
function Shell({ children, seller }: { children: ReactNode; seller?: string | undefined }) {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-xl flex-col justify-center px-6 py-16">
      <p className="label-micro mb-10">Invoice confirmation</p>
      <div>{children}</div>
      <p className="mt-14 border-t border-rule pt-5 text-xs text-faint">
        {seller ?? 'The sender'} uses Facture to manage the invoices they are owed. You do not need
        an account and there is nothing to install.
      </p>
    </main>
  );
}
