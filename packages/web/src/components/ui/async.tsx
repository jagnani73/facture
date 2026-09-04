'use client';

import type { ReactNode } from 'react';

import { describeFailure, isApiError, traceApiError } from '@/lib/api/problem';
import { Button, Card, Label } from './primitives';

/**
 * Waiting, and not getting an answer.
 *
 * Both states are written the way a refusal is written in this product: a sentence that
 * names what was being asked for and what happened, never a code on its own and never the
 * word "error" where a plainer word does the job. A screen that cannot price an invoice
 * says so; it does not render a zero.
 *
 * They are quiet on purpose. This is a printed page of paper prices, so a pending row is a
 * ruled gap where a figure will be, not a spinning brand mark.
 */

/** Ruled placeholder lines, so a loading page keeps the shape of the page it becomes. */
export function Pending({
  what,
  lines = 3,
  className = '',
}: {
  what: string;
  lines?: number;
  className?: string;
}) {
  return (
    <Card className={`px-5 py-5 ${className}`} aria-busy="true">
      <Label>Reading {what}</Label>
      <div className="mt-4 space-y-3" aria-hidden>
        {Array.from({ length: lines }, (_, index) => (
          <div
            key={index}
            className="h-3 rounded-xs bg-sunken"
            style={{ width: `${100 - index * 13}%` }}
          />
        ))}
      </div>
      <p className="mt-4 text-xs text-faint">
        Nothing is shown until the figures are the venue&rsquo;s.
      </p>
    </Card>
  );
}

export function Failure({
  error,
  what,
  onRetry,
  className = '',
  children,
}: {
  error: unknown;
  /** What the reader was trying to see, in the product's own words. */
  what: string;
  onRetry?: (() => void) | undefined;
  className?: string;
  children?: ReactNode;
}) {
  const sentence = describeFailure(error, what);
  const trace = isApiError(error) ? traceApiError(error) : null;

  return (
    <Card className={`border-warn/40 px-5 py-5 ${className}`} role="alert">
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border border-warn/50 text-[0.6875rem] font-semibold text-warn"
        >
          !
        </span>
        <div className="min-w-0 flex-1">
          <Label className="mb-1">Not loaded</Label>
          <p className="text-sm text-ink">{sentence}</p>
          {children ? <div className="mt-2 text-sm text-muted">{children}</div> : null}
          <div className="mt-3 flex flex-wrap items-center gap-3">
            {onRetry ? (
              <Button size="sm" onClick={onRetry}>
                Try again
              </Button>
            ) : null}
            {trace ? <span className="num text-[0.6875rem] text-faint">{trace}</span> : null}
          </div>
        </div>
      </div>
    </Card>
  );
}

/** A short one-line failure, for a panel inside an otherwise working page. */
export function FailureLine({ error, what }: { error: unknown; what: string }) {
  return <p className="text-sm text-warn">{describeFailure(error, what)}</p>;
}
