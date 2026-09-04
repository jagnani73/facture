import { describe, expect, it } from 'vitest';
import { reachableFrom } from '../../src/state/machine.js';
import { INVOICE_TRANSITIONS, invoiceMachine } from '../../src/state/invoice-machine.js';
import { MANDATE_TRANSITIONS, mandateMachine } from '../../src/state/mandate-machine.js';
import { INVOICE_STATUSES, type InvoiceStatus } from '../../src/types/invoice.js';
import { MANDATE_STATUSES, type MandateStatus } from '../../src/types/mandate.js';

describe('invoice transition table — structure', () => {
  it('has an entry for every status and no others', () => {
    expect(Object.keys(INVOICE_TRANSITIONS).sort()).toEqual([...INVOICE_STATUSES].sort());
  });

  it('only ever targets real statuses', () => {
    for (const targets of Object.values(INVOICE_TRANSITIONS)) {
      for (const target of targets) {
        expect(INVOICE_STATUSES).toContain(target);
      }
    }
  });

  it('never lists a target twice', () => {
    for (const targets of Object.values(INVOICE_TRANSITIONS)) {
      expect(new Set(targets).size).toBe(targets.length);
    }
  });

  it('has no self-transitions — a no-op write is a bug, not an intent', () => {
    for (const [from, targets] of Object.entries(INVOICE_TRANSITIONS)) {
      expect(targets).not.toContain(from);
    }
  });

  it('can reach every status from draft, so nothing is stranded', () => {
    expect(reachableFrom(INVOICE_TRANSITIONS, 'draft').size).toBe(INVOICE_STATUSES.length);
  });

  it('treats matured and defaulted as the only terminal states', () => {
    expect([...invoiceMachine.terminalStates].sort()).toEqual(['defaulted', 'matured']);
  });
});

describe('invoice transitions — the edges that carry an argument', () => {
  it('lets a holder relist sold paper, which is what makes it a secondary market', () => {
    expect(invoiceMachine.canTransition('sold', 'listed')).toBe(true);
  });

  it('will not price an invoice the debtor has not confirmed', () => {
    expect(invoiceMachine.canTransition('draft', 'listed')).toBe(false);
    expect(invoiceMachine.canTransition('draft', 'confirmed')).toBe(false);
    expect(invoiceMachine.canTransition('awaiting_confirmation', 'listed')).toBe(false);
  });

  it('lets the seller pull a confirmation request back before the debtor answers', () => {
    expect(invoiceMachine.canTransition('awaiting_confirmation', 'draft')).toBe(true);
    // ...but not after. Editing an acknowledged amount would silently void the acknowledgement.
    expect(invoiceMachine.canTransition('confirmed', 'draft')).toBe(false);
  });

  it('lets a dispute be resolved either way', () => {
    expect(invoiceMachine.canTransition('disputed', 'confirmed')).toBe(true);
    expect(invoiceMachine.canTransition('disputed', 'defaulted')).toBe(true);
  });

  it('does not let a sale be undone by a status write', () => {
    // Unwinding a trade reverses two settlement legs on two chains; it is not a state change.
    expect(invoiceMachine.canTransition('sold', 'confirmed')).toBe(false);
  });

  it('lets a listing be pulled without disputing anything', () => {
    expect(invoiceMachine.canTransition('listed', 'confirmed')).toBe(true);
  });
});

describe('invoice transition() results', () => {
  it('returns the new status on a legal move', () => {
    const result = invoiceMachine.transition('confirmed', 'listed');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe('listed');
  });

  it('returns ILLEGAL_TRANSITION with the legal alternatives, never throws', () => {
    const result = invoiceMachine.transition('draft', 'sold');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('ILLEGAL_TRANSITION');
      if (result.error.code === 'ILLEGAL_TRANSITION') {
        expect(result.error.allowed).toEqual(['awaiting_confirmation']);
      }
      expect(result.error.reason).toContain('awaiting_confirmation');
    }
  });

  it('distinguishes a terminal state from a merely illegal move', () => {
    const result = invoiceMachine.transition('matured', 'listed');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('TERMINAL_STATE');
  });

  it('refuses a self-transition', () => {
    const result = invoiceMachine.transition('listed', 'listed');
    expect(result.ok).toBe(false);
  });

  it('rejects strings that are not statuses at all', () => {
    const result = invoiceMachine.transitionUnchecked('confirmed', 'sold_out');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('UNKNOWN_STATE');
  });

  it('accepts unvalidated strings that happen to be a legal move', () => {
    const result = invoiceMachine.transitionUnchecked('confirmed', 'listed');
    expect(result.ok).toBe(true);
  });

  it('agrees with canTransition on every ordered pair', () => {
    for (const from of INVOICE_STATUSES) {
      for (const to of INVOICE_STATUSES) {
        const allowed = invoiceMachine.canTransition(from, to);
        expect(invoiceMachine.transition(from, to).ok).toBe(allowed);
      }
    }
  });

  it('is exhaustive over every ordered pair — the legal set is exactly this', () => {
    const legal: string[] = [];
    for (const from of INVOICE_STATUSES) {
      for (const to of INVOICE_STATUSES) {
        if (invoiceMachine.canTransition(from, to)) legal.push(`${from}->${to}`);
      }
    }
    expect(legal.sort()).toEqual(
      [
        'draft->awaiting_confirmation',
        'awaiting_confirmation->draft',
        'awaiting_confirmation->confirmed',
        'awaiting_confirmation->disputed',
        'confirmed->listed',
        'confirmed->disputed',
        'listed->confirmed',
        'listed->sold',
        'listed->disputed',
        'sold->listed',
        'sold->matured',
        'sold->defaulted',
        'sold->disputed',
        'disputed->confirmed',
        'disputed->defaulted',
      ].sort(),
    );
  });
});

describe('mandate transition table', () => {
  it('has an entry for every status and only targets real statuses', () => {
    expect(Object.keys(MANDATE_TRANSITIONS).sort()).toEqual([...MANDATE_STATUSES].sort());
    for (const targets of Object.values(MANDATE_TRANSITIONS)) {
      for (const target of targets) expect(MANDATE_STATUSES).toContain(target);
    }
  });

  it('treats withdrawn as the only terminal state', () => {
    expect(mandateMachine.terminalStates).toEqual(['withdrawn']);
  });

  it('can reach every status from draft', () => {
    expect(reachableFrom(MANDATE_TRANSITIONS, 'draft').size).toBe(MANDATE_STATUSES.length);
  });

  it('will not let an unfunded mandate quote', () => {
    // draft and funding cannot become anything that matches; only `active` does.
    expect(mandateMachine.canTransition('draft', 'active')).toBe(false);
    expect(mandateMachine.canTransition('funding', 'active')).toBe(true);
  });

  it('lets an exhausted mandate come back when capacity is released', () => {
    expect(mandateMachine.canTransition('exhausted', 'active')).toBe(true);
  });

  it('lets any non-terminal state be withdrawn', () => {
    for (const from of ['draft', 'funding', 'active', 'exhausted'] as MandateStatus[]) {
      expect(mandateMachine.canTransition(from, 'withdrawn')).toBe(true);
    }
  });

  it('does not revive a withdrawn mandate', () => {
    for (const to of MANDATE_STATUSES) {
      expect(mandateMachine.canTransition('withdrawn', to)).toBe(false);
    }
    const result = mandateMachine.transition('withdrawn', 'active');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('TERMINAL_STATE');
  });

  it('does not make a live bid provisional again', () => {
    expect(mandateMachine.canTransition('active', 'funding')).toBe(false);
    expect(mandateMachine.canTransition('active', 'draft')).toBe(false);
  });

  it('is exhaustive over every ordered pair', () => {
    const legal: string[] = [];
    for (const from of MANDATE_STATUSES) {
      for (const to of MANDATE_STATUSES) {
        if (mandateMachine.canTransition(from, to)) legal.push(`${from}->${to}`);
      }
    }
    expect(legal.sort()).toEqual(
      [
        'draft->funding',
        'draft->withdrawn',
        'funding->active',
        'funding->withdrawn',
        'active->exhausted',
        'active->withdrawn',
        'exhausted->active',
        'exhausted->withdrawn',
      ].sort(),
    );
  });
});

describe('machine helpers', () => {
  it('narrows unknown values to statuses', () => {
    expect(invoiceMachine.isState('listed')).toBe(true);
    expect(invoiceMachine.isState('LISTED')).toBe(false);
    expect(invoiceMachine.isState(7)).toBe(false);
    expect(invoiceMachine.isState(undefined)).toBe(false);
  });

  it('reports terminality per status', () => {
    const terminal: InvoiceStatus[] = ['matured', 'defaulted'];
    for (const status of INVOICE_STATUSES) {
      expect(invoiceMachine.isTerminal(status)).toBe(terminal.includes(status));
    }
  });
});
