/**
 * What the proof view says the chain says.
 *
 * `InvoiceRegistry.isConfirmed(invoiceId)` is a public view, so the debtor's acknowledgement
 * stops being a column only the venue can see. That acknowledgement is what justifies
 * advancing the full face value with no holdback, which makes it the claim on this page most
 * worth checking somewhere that is not us — and the reason it is rendered at all.
 *
 * What is pinned here is the part `tsc` cannot see: **three states, not two.** `checked:
 * false` is a question that went unanswered — no registry configured, or a node that could
 * not be read — and a screen that renders it as "not confirmed" makes a negative claim
 * nobody made, one line under a confirmation the venue is certain of. This repo has lost that
 * distinction twice already, in `/health` and in `ComplianceDecision.determinate`, so it is
 * asserted at the place a human actually reads it rather than only at the decoder.
 */

import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { held } = vi.hoisted(() => ({ held: { proof: null as unknown } }));

vi.mock('@/lib/data/hooks', () => ({ useProof: () => held.proof }));

/*
 * The proof view imports the claim button, which imports Privy at module scope. Nothing
 * below renders a claimable lock, so the seam is stubbed rather than stood up.
 */
vi.mock('@privy-io/react-auth', () => ({
  useWallets: () => ({ wallets: [] }),
  useSendTransaction: () => ({ sendTransaction: vi.fn() }),
}));

import type { InvoiceRegistryAnswer } from '@/lib/api/contract';
import type { ProofRecord } from '@/lib/data';
import { fixtureProof } from '@/lib/data/fixture-source';
import { ProofView } from '@/components/views/proof-view';

/** The demo book's fully-settled trade, which every case below varies one field of. */
const TRADE = 'TRD-4417';

const base = (): ProofRecord => {
  const record = fixtureProof(TRADE);
  if (record === null) throw new Error(`the demo book has no proof for ${TRADE}`);
  return record;
};

function show(
  registry: Partial<InvoiceRegistryAnswer>,
  confirmation?: ProofRecord['confirmation'],
): void {
  const record = base();
  held.proof = {
    status: 'ready',
    reload: vi.fn(),
    data: {
      ...record,
      confirmation: confirmation ?? record.confirmation,
      registry: { ...record.registry, ...registry },
    },
  };
  render(<ProofView tradeId={TRADE} />);
}

/** The registry block, isolated from the compliance checklist it sits under. */
const block = (): HTMLElement => {
  const label = screen.getByText('The public invoice registry');
  const parent = label.parentElement;
  if (parent === null) throw new Error('the registry block has no container');
  return parent;
};

beforeEach(() => {
  held.proof = null;
});

afterEach(cleanup);

describe('the public invoice registry, on the proof view', () => {
  it('renders the chain’s answer when the venue got one', () => {
    show({ checked: true, listed: true, confirmed: true });

    const registry = within(block());
    expect(registry.getByText('Listed on chain')).toBeTruthy();
    expect(registry.getByText('Confirmed on chain')).toBeTruthy();
    expect(registry.getAllByText('Yes')).toHaveLength(2);
  });

  /*
   * A no is a real answer and reads as one. The venue writes `Draft` at listing and
   * `Confirmed` when the customer answers, and neither write is allowed to fail the thing it
   * records — so an invoice can genuinely be unconfirmed on chain, and saying so is the
   * point.
   */
  it('renders a refusal as a refusal', () => {
    show({ checked: true, listed: true, confirmed: false });

    const registry = within(block());
    expect(registry.getByText('No')).toBeTruthy();
    expect(registry.getByText('Yes')).toBeTruthy();
    expect(registry.queryByText('Not answered')).toBeNull();
  });

  /*
   * The case this whole block exists for. An unanswered question must not render as a no:
   * a registry that is unconfigured or a node that blinked would otherwise put "not
   * confirmed" beside a confirmation the venue holds a signed decision for.
   */
  it('does not render an unanswered question as a no', () => {
    show({ checked: false, listed: null, confirmed: null });

    const registry = within(block());
    expect(registry.queryByText('No')).toBeNull();
    expect(registry.queryByText('Yes')).toBeNull();
    expect(registry.queryByText('Listed on chain')).toBeNull();
    expect(registry.queryByText('Confirmed on chain')).toBeNull();
    expect(registry.getByText(/Not asked/)).toBeTruthy();
  });

  /** Three states stay three: read, and answered with nothing, are not the same fact. */
  it('keeps a null answer distinct from a no even when the registry was read', () => {
    show({ checked: true, listed: true, confirmed: null });

    const registry = within(block());
    expect(registry.getByText('Yes')).toBeTruthy();
    expect(registry.getByText('Not answered')).toBeTruthy();
    expect(registry.queryByText('No')).toBeNull();
  });

  /*
   * A disagreement is shown rather than resolved. The venue's column and the public view are
   * two parties answering one question; picking one would leave the stronger-looking claim
   * standing alone, which is the failure this screen is built against.
   */
  it('says so when the chain and the venue disagree', () => {
    show(
      { checked: true, listed: true, confirmed: false },
      {
        decision: 'confirmed',
        decidedAt: '2026-08-14T13:19:52.000Z',
      },
    );

    expect(within(block()).getByText(/disagree about this invoice/)).toBeTruthy();
  });

  it('says nothing about a disagreement when there is none', () => {
    show({ checked: true, listed: true, confirmed: true });
    expect(within(block()).queryByText(/disagree about this invoice/)).toBeNull();

    /*
     * Nor when the registry was never read. Two parties cannot disagree when only one of
     * them spoke, and flagging that would turn an outage into an accusation.
     */
    cleanup();
    show({ checked: false, listed: null, confirmed: null });
    expect(within(block()).queryByText(/disagree about this invoice/)).toBeNull();
  });

  /*
   * The case the demo book is made of, and the one that was wrong.
   *
   * `isListed` is the contract's own "does this receivable have a record here at all", so a
   * `confirmed: false` beside `listed: false` is the absence of a row rather than a debtor
   * saying no. Every seeded trade is a confirmed invoice that was never written to the
   * registry, so the note fired on all of them and accused the venue of contradicting a
   * chain that had never been told anything.
   */
  it('does not call it a disagreement when the chain has no record', () => {
    show(
      { checked: true, listed: false, confirmed: false },
      { decision: 'confirmed', decidedAt: '2026-08-14T13:19:52.000Z' },
    );

    expect(within(block()).queryByText(/disagree about this invoice/)).toBeNull();
    expect(within(block()).getByText('No record to confirm')).toBeTruthy();
  });

  it('still reports the invoice as not listed in that case', () => {
    show(
      { checked: true, listed: false, confirmed: false },
      { decision: 'confirmed', decidedAt: '2026-08-14T13:19:52.000Z' },
    );

    // The absence is a real answer and is still shown; only the accusation is withheld.
    expect(within(block()).getByText('Listed on chain')).toBeTruthy();
    expect(within(block()).getByText('No')).toBeTruthy();
  });

  /*
   * A null identifier produces no link, on this screen above all others: an explorer URL
   * that 404s converts "verifiable" into "looks verifiable".
   */
  it('links to the registry contract only when there is one to link to', () => {
    show({ checked: true, explorerUrl: 'https://hashscan.io/testnet/contract/0x1' });
    expect(
      within(block())
        .getByRole('link', { name: /Open the registry contract/ })
        .getAttribute('href'),
    ).toBe('https://hashscan.io/testnet/contract/0x1');

    cleanup();
    show({ checked: true, explorerUrl: null, contractAddress: null });
    expect(within(block()).queryByRole('link', { name: /Open the registry contract/ })).toBeNull();
  });
});

/*
 * The instrument's declared offering, which reached this screen from fixtures and never from
 * the venue: `api-source.ts` hardcoded `regulation: null` beside a comment saying the proof
 * contract carried no such field. It does now, and the row it feeds is the only thing on this
 * page a reader could check against the instrument's own deploy calldata.
 */
describe('the declared offering', () => {
  it('renders the label for whichever regulation the record carries', () => {
    const record = base();
    held.proof = {
      status: 'ready',
      reload: vi.fn(),
      data: { ...record, instrument: { ...record.instrument, regulation: 'REG_S' } },
    };
    render(<ProofView tradeId={TRADE} />);
    expect(screen.getByText('Reg S')).toBeTruthy();
  });

  /*
   * Asserted on the labels rather than on the row's term, because "Regulation" is also the
   * name of one of the compliance checks — and a test that passed on the wrong element would
   * be pinning the checklist rather than the declaration.
   */
  it('names no regulation when the venue declared none', () => {
    const record = base();
    held.proof = {
      status: 'ready',
      reload: vi.fn(),
      data: { ...record, instrument: { ...record.instrument, regulation: null } },
    };
    render(<ProofView tradeId={TRADE} />);
    for (const label of ['Reg S', 'Reg D 506(b)', 'Reg D 506(c)']) {
      expect(screen.queryByText(label)).toBeNull();
    }
  });
});
