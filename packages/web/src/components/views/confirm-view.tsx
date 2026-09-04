'use client';

import type { ReactNode } from 'react';
import { useState } from 'react';

import { formatDateProse, formatMoney } from '@/lib/format';
import { debtorNameOf, invoiceForToken, seller } from '@/lib/fixtures';
import { Button } from '@/components/ui/primitives';

/**
 * The debtor confirmation page.
 *
 * One sentence and two buttons. No account, no wallet, no software, no jargon,
 * and nothing on the screen that reveals what is underneath — because the person
 * reading it is not a customer of this market, they are somebody's accounts
 * payable clerk being asked about their own ledger.
 *
 * This works for a behavioural reason rather than a cryptographic one: they are
 * not vouching for a stranger, they are acknowledging a bill they already know
 * about, which costs them nothing and which they have no reason to deny.
 */

type Answer = 'unanswered' | 'confirmed' | 'querying' | 'queried';

const PROBLEMS = [
  'The amount is different',
  'We have already paid this',
  'The due date is different',
  'We did not order this',
] as const;

export function ConfirmView({ token }: { token: string }) {
  const invoice = invoiceForToken(token);
  const [answer, setAnswer] = useState<Answer>('unanswered');
  const [problem, setProblem] = useState<string>('');

  if (!invoice) {
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

  if (answer === 'confirmed') {
    return (
      <Shell>
        <p className="font-serif text-2xl leading-snug">Thank you — that is all we needed.</p>
        <p className="mt-4 text-sm text-muted">
          Nothing about this invoice has changed. You still pay {seller.name} the same amount, on{' '}
          {formatDateProse(invoice.dueAt)}, in the same way you always have.
        </p>
        <p className="mt-3 text-sm text-muted">You can close this page.</p>
      </Shell>
    );
  }

  if (answer === 'queried') {
    return (
      <Shell>
        <p className="font-serif text-2xl leading-snug">We have told {seller.name}.</p>
        <p className="mt-4 text-sm text-muted">
          {problem === '' ? 'They' : `We passed on that ${problem.toLowerCase()}, and they`} will be
          in touch with you directly. Nothing happens to this invoice in the meantime.
        </p>
        <p className="mt-3 text-sm text-muted">You can close this page.</p>
      </Shell>
    );
  }

  if (answer === 'querying') {
    return (
      <Shell>
        <p className="font-serif text-2xl leading-snug">What is not right?</p>
        <div className="mt-6 space-y-2">
          {PROBLEMS.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => {
                setProblem(option);
                setAnswer('queried');
              }}
              className="block w-full rounded-sm border border-rule bg-raised px-4 py-3 text-left text-sm transition-colors hover:border-accent hover:text-accent"
            >
              {option}
            </button>
          ))}
        </div>
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
    <Shell>
      <p className="font-serif text-[1.75rem] leading-snug sm:text-[2rem]">
        {seller.name} says you owe them{' '}
        <span className="num whitespace-nowrap" data-num>
          {formatMoney(invoice.faceValue, { fractionDigits: 0 })}
        </span>
        , due {formatDateProse(invoice.dueAt)}.
      </p>
      <p className="mt-4 text-lg">Is that right?</p>

      <div className="mt-8 flex flex-col gap-3 sm:flex-row">
        <Button variant="primary" size="lg" onClick={() => setAnswer('confirmed')}>
          Yes, that is right
        </Button>
        <Button size="lg" onClick={() => setAnswer('querying')}>
          No, something is wrong
        </Button>
      </div>

      <dl className="mt-10 border-t border-rule pt-5 text-sm">
        <div className="flex justify-between gap-6 py-1.5">
          <dt className="text-muted">Invoice</dt>
          <dd className="num">{invoice.invoiceNumber}</dd>
        </div>
        <div className="flex justify-between gap-6 py-1.5">
          <dt className="text-muted">From</dt>
          <dd>{seller.name}</dd>
        </div>
        <div className="flex justify-between gap-6 py-1.5">
          <dt className="text-muted">To</dt>
          <dd>{debtorNameOf(invoice)}</dd>
        </div>
        <div className="flex justify-between gap-6 py-1.5">
          <dt className="text-muted">Amount</dt>
          <dd className="num">{formatMoney(invoice.faceValue)}</dd>
        </div>
        <div className="flex justify-between gap-6 py-1.5">
          <dt className="text-muted">Due</dt>
          <dd className="num">{formatDateProse(invoice.dueAt)}</dd>
        </div>
      </dl>

      <p className="mt-6 text-xs text-muted">
        Saying yes does not commit you to paying any earlier, and it does not sign you up to
        anything. It confirms the amount and the date are the ones on your own ledger.
      </p>
    </Shell>
  );
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-xl flex-col justify-center px-6 py-16">
      <p className="label-micro mb-10">Invoice confirmation</p>
      <div>{children}</div>
      <p className="mt-14 border-t border-rule pt-5 text-xs text-faint">
        {seller.name} uses Facture to manage the invoices they are owed. You do not need an account
        and there is nothing to install.
      </p>
    </main>
  );
}
