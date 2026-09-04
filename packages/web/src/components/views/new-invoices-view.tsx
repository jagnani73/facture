'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';

import type { Debtor, Invoice, Rating } from '@/lib/domain';
import { bestQuote, uniquenessHash } from '@/lib/domain';
import { formatDate, formatDays, formatMoney, formatRate, toMinor } from '@/lib/format';
import { debtors, getDebtorByName, mandates, marketNow, seller } from '@/lib/fixtures';
import { RatingChip } from '@/components/rating-chip';
import { StatusPill } from '@/components/status-pill';
import {
  Button,
  Card,
  CardHead,
  Field,
  Label,
  PageHeader,
  TextArea,
  TextInput,
  buttonClasses,
} from '@/components/ui/primitives';

/**
 * Adding invoices.
 *
 * Two paths, because sellers arrive in two states: one invoice they are looking at right
 * now, or a whole book pasted out of their accounting package. Both show what the invoice
 * would be worth before it is added, because the reason anyone is on this page is that
 * number.
 *
 * Nothing here promises the book will be ready instantly. Issuance is paced on purpose,
 * and the screen says so rather than showing a spinner that lies.
 */

interface Draft {
  key: string;
  customer: string;
  reference: string;
  amountMajor: number;
  dueOn: string;
  problem?: string;
}

export function NewInvoicesView() {
  const [staged, setStaged] = useState<Draft[]>([]);

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="The book"
        title="Add invoices"
        lede="Customer, amount, your reference, due date. Each one is priced as soon as your customer confirms it — you do not have to come back and ask."
        actions={
          <Link href="/book" className={buttonClasses('secondary')}>
            Back to the book
          </Link>
        }
      />

      <div className="grid gap-6 lg:grid-cols-2">
        <SingleEntry onAdd={(draft) => setStaged((list) => [...list, draft])} />
        <PasteEntry onAdd={(drafts) => setStaged((list) => [...list, ...drafts])} />
      </div>

      <StagedList drafts={staged} onClear={() => setStaged([])} />
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function SingleEntry({ onAdd }: { onAdd: (draft: Draft) => void }) {
  const [customer, setCustomer] = useState('');
  const [reference, setReference] = useState('');
  const [amount, setAmount] = useState('');
  const [dueOn, setDueOn] = useState('');

  const amountMajor = parseAmount(amount);
  const preview = usePreview(customer, amountMajor, dueOn);
  const ready = customer.trim() !== '' && amountMajor > 0 && isIsoDate(dueOn);

  return (
    <Card>
      <CardHead title="One at a time" hint="The way most invoices get added." />
      <form
        className="space-y-4 px-5 py-5"
        onSubmit={(event) => {
          event.preventDefault();
          if (!ready) return;
          onAdd({
            key: `${Date.now()}-${reference || customer}`,
            customer: customer.trim(),
            reference: reference.trim() || 'no reference',
            amountMajor,
            dueOn,
          });
          setCustomer('');
          setReference('');
          setAmount('');
          setDueOn('');
        }}
      >
        <Field label="Customer" htmlFor="customer">
          <TextInput
            id="customer"
            value={customer}
            onChange={(event) => setCustomer(event.target.value)}
            placeholder="Halden Aerospace"
            list="known-customers"
            autoComplete="off"
          />
          <datalist id="known-customers">
            {debtors.map((debtor) => (
              <option key={debtor.id} value={debtor.name} />
            ))}
          </datalist>
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Your reference" htmlFor="reference">
            <TextInput
              id="reference"
              value={reference}
              onChange={(event) => setReference(event.target.value)}
              placeholder="MF-2053"
              autoComplete="off"
            />
          </Field>
          <Field label="Amount" htmlFor="amount">
            <TextInput
              id="amount"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              placeholder="40,000"
              inputMode="decimal"
              autoComplete="off"
            />
          </Field>
        </div>

        <Field label="Due date" htmlFor="due" hint="The date your customer has agreed to pay.">
          <TextInput
            id="due"
            type="date"
            value={dueOn}
            onChange={(event) => setDueOn(event.target.value)}
          />
        </Field>

        <PreviewStrip preview={preview} />

        <Button type="submit" variant="primary" disabled={!ready}>
          Add to the book
        </Button>
      </form>
    </Card>
  );
}

/* -------------------------------------------------------------------------- */

const SAMPLE = `Halden Aerospace, MF-2053, 40000, 2026-11-14
Lumen Grid Utilities, MF-2054, 61250, 2026-10-02
Sable Interiors, MF-2055, 4800, 2026-09-28`;

function PasteEntry({ onAdd }: { onAdd: (drafts: Draft[]) => void }) {
  const [text, setText] = useState('');
  const parsed = useMemo(() => parseCsv(text), [text]);
  const good = parsed.filter((row) => row.problem === undefined);

  return (
    <Card>
      <CardHead
        title="Paste from a spreadsheet"
        hint="Customer, reference, amount, due date — one invoice per line. A header row is ignored."
      />
      <div className="space-y-4 px-5 py-5">
        <TextArea
          rows={7}
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder={SAMPLE}
          aria-label="Paste invoices"
        />

        <div className="flex flex-wrap items-center gap-3">
          <Button variant="quiet" size="sm" type="button" onClick={() => setText(SAMPLE)}>
            Use an example
          </Button>
          {parsed.length > 0 ? (
            <span className="text-xs text-muted">
              {good.length} of {parsed.length} lines read cleanly
            </span>
          ) : null}
        </div>

        {parsed.length > 0 ? (
          <div className="overflow-hidden rounded-sm border border-rule">
            <table className="w-full border-collapse text-xs">
              <tbody>
                {parsed.map((row) => (
                  <tr key={row.key} className="border-b border-rule last:border-0">
                    <td className="px-3 py-2">
                      {row.customer || <em className="text-faint">no customer</em>}
                    </td>
                    <td className="num px-3 py-2 text-muted">{row.reference}</td>
                    <td className="num px-3 py-2 text-right">
                      {row.amountMajor > 0
                        ? formatMoney(toMinor(row.amountMajor), { fractionDigits: 0 })
                        : '—'}
                    </td>
                    <td className="num px-3 py-2">
                      {isIsoDate(row.dueOn) ? formatDate(row.dueOn) : '—'}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {row.problem ? (
                        <span className="text-neg">{row.problem}</span>
                      ) : (
                        <span className="text-pos">ready</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}

        <Button
          type="button"
          variant="primary"
          disabled={good.length === 0}
          onClick={() => {
            onAdd(good);
            setText('');
          }}
        >
          Add {good.length || ''} {good.length === 1 ? 'invoice' : 'invoices'}
        </Button>
      </div>
    </Card>
  );
}

/* -------------------------------------------------------------------------- */

function StagedList({ drafts, onClear }: { drafts: readonly Draft[]; onClear: () => void }) {
  if (drafts.length === 0) {
    return (
      <Card className="px-5 py-8 text-center">
        <p className="text-sm text-muted">
          Nothing added yet. Anything you add appears here while it is being set up.
        </p>
      </Card>
    );
  }

  const face = drafts.reduce((total, draft) => total + toMinor(draft.amountMajor), 0n);

  return (
    <Card>
      <CardHead
        title="Being added"
        hint="Issuance is paced deliberately, so a large book does not arrive all at once. Nothing is waiting on it — you can close this page."
        right={
          <Button variant="quiet" size="sm" onClick={onClear}>
            Clear
          </Button>
        }
      />
      <div className="px-5 py-3">
        {drafts.map((draft) => (
          <div key={draft.key} className="ledger-row flex items-center justify-between gap-4 py-3">
            <div className="min-w-0">
              <p className="truncate text-sm">{draft.customer}</p>
              <p className="num text-xs text-muted">
                {draft.reference} · due {formatDate(draft.dueOn)}
              </p>
            </div>
            <div className="flex items-center gap-4">
              <span className="num text-sm" data-num>
                {formatMoney(toMinor(draft.amountMajor), { fractionDigits: 0 })}
              </span>
              <StatusPill status="draft" issued={false} />
            </div>
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between border-t border-rule px-5 py-3.5 text-sm">
        <span className="text-muted">
          {drafts.length} {drafts.length === 1 ? 'invoice' : 'invoices'} queued
        </span>
        <span className="num font-medium" data-num>
          {formatMoney(face, { fractionDigits: 0 })}
        </span>
      </div>
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/* The live preview                                                            */
/* -------------------------------------------------------------------------- */

interface Preview {
  rating: Rating;
  known: boolean;
  days: number;
  rateBps: number | null;
  proceeds: bigint;
  takers: number;
}

const NEW_CUSTOMER: Debtor = {
  id: 'DBT-NEW',
  name: 'New customer',
  rating: 'UNRATED',
  onTimeCount: 0,
  defaultCount: 0,
  confirmedCount: 0,
};

/**
 * Priced through the same `bestQuote` the book uses, so what this strip promises is what
 * the row will say once the customer confirms it.
 */
function usePreview(customer: string, amountMajor: number, dueOn: string): Preview | null {
  const asOf = useMemo(() => marketNow(), []);

  return useMemo(() => {
    if (amountMajor <= 0 || !isIsoDate(dueOn)) return null;

    const match = getDebtorByName(customer);
    const debtor = match ?? NEW_CUSTOMER;
    const faceValue = toMinor(amountMajor);

    const invoice: Invoice = {
      id: 'INV-PREVIEW',
      sellerId: seller.id,
      debtorId: debtor.id,
      faceValue,
      currency: 'USD',
      invoiceNumber: 'PREVIEW',
      issuedAt: asOf.toISOString(),
      dueAt: `${dueOn}T00:00:00.000Z`,
      status: 'confirmed',
      uniquenessHash: uniquenessHash(debtor.id, 'PREVIEW', faceValue),
    };

    const result = bestQuote(invoice, mandates, debtor, { asOf });

    return {
      rating: debtor.rating,
      known: match !== undefined,
      days: result.tenorDays,
      rateBps: result.quote?.annualisedYieldBps ?? null,
      proceeds: result.quote?.proceeds ?? 0n,
      takers: result.matches.length,
    };
  }, [customer, amountMajor, dueOn, asOf]);
}

function PreviewStrip({ preview }: { preview: Preview | null }) {
  if (!preview) {
    return (
      <div className="rounded-sm border border-dashed border-rule px-4 py-3 text-xs text-muted">
        Fill in an amount and a due date and the price appears here.
      </div>
    );
  }

  return (
    <div className="rounded-sm border border-rule bg-sunken px-4 py-3.5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <Label>Once confirmed, worth</Label>
        <span className="inline-flex items-center gap-2 text-xs text-muted">
          <RatingChip rating={preview.rating} />
          {preview.known ? 'known customer' : 'new customer — prices wide until they settle one'}
        </span>
      </div>

      {preview.rateBps === null ? (
        <p className="mt-2 text-sm text-muted">
          No standing bid reaches this one yet. It still goes in the book, and it is priced the
          moment a mandate does.
        </p>
      ) : (
        <p className="mt-2 text-sm">
          <span className="num text-xl font-medium" data-num>
            {formatMoney(preview.proceeds)}
          </span>
          <span className="ml-2 text-xs text-muted">
            {formatRate(preview.rateBps)} annualised over {formatDays(preview.days)} ·{' '}
            {preview.takers} {preview.takers === 1 ? 'mandate' : 'mandates'}
          </span>
        </p>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Parsing                                                                     */
/* -------------------------------------------------------------------------- */

function parseAmount(raw: string): number {
  const cleaned = raw.replace(/[^0-9.]/g, '');
  const value = Number.parseFloat(cleaned);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

function parseCsv(text: string): Draft[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .filter((line) => !/^customer\b/i.test(line))
    .map((line, index) => {
      const cells = line.split(',').map((cell) => cell.trim().replace(/^"|"$/g, ''));
      const [customer = '', reference = '', amount = '', dueOn = ''] = cells;
      const amountMajor = parseAmount(amount);

      let problem: string | undefined;
      if (cells.length < 4) problem = 'needs four values';
      else if (customer === '') problem = 'no customer';
      else if (amountMajor <= 0) problem = 'amount not readable';
      else if (!isIsoDate(dueOn)) problem = 'date must be YYYY-MM-DD';

      const draft: Draft = {
        key: `${index}-${line}`,
        customer,
        reference: reference || 'no reference',
        amountMajor,
        dueOn,
      };
      return problem === undefined ? draft : { ...draft, problem };
    });
}
