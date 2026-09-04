import Link from 'next/link';
import type { ReactNode } from 'react';

import { CurveStrip } from '@/components/curve-strip';
import { HeroQuote } from '@/components/views/hero-quote';
import { Card, Label, buttonClasses } from '@/components/ui/primitives';
import { mandates, metaOf } from '@/lib/fixtures';
import { curveFrom } from '@/lib/pricing';

/**
 * The argument, in the order it has to be made: the instrument was always a
 * bond, the reason no market formed was fungibility, and the move is to
 * standardise the bid rather than the paper.
 */
export default function LandingPage() {
  return (
    <div className="space-y-16">
      <section className="grid gap-10 lg:grid-cols-[1.15fr_1fr] lg:items-center">
        <div>
          <Label className="mb-4">The market that should exist</Label>
          <h1 className="text-4xl leading-[1.1] sm:text-5xl">
            An invoice is a zero-coupon bond that nobody ever priced.
          </h1>
          <p className="mt-6 max-w-xl text-base text-muted">
            Factoring is bond pricing done over the phone. A business that is owed money calls a
            factor, the factor prices the paper privately, and the business takes two to five per
            cent off face for the privilege of not waiting. There is no screen, no curve and no
            second buyer.
          </p>
          <p className="mt-4 max-w-xl text-base text-muted">
            Facture puts a price beside every invoice the moment it appears, because the buyers were
            already there.
          </p>

          <div className="mt-8 flex flex-wrap gap-3">
            <Link href="/book" className={buttonClasses('primary', 'lg')}>
              Open the book
            </Link>
            <Link href="/mandates" className={buttonClasses('secondary', 'lg')}>
              See the buyer side
            </Link>
          </div>
        </div>

        <HeroQuote />
      </section>

      <section className="grid gap-10 border-t border-rule pt-12 lg:grid-cols-2">
        <div>
          <h2 className="text-2xl leading-tight">Why invoice finance never got a market</h2>
          <p className="mt-4 text-sm text-muted">
            Not regulation, and not custody. It is that <strong>invoices are not fungible.</strong>{' '}
            Every receivable is a different customer, a different amount and a different number of
            days to maturity, so no two are the same asset. An order book needs something to book,
            and there is nothing here that repeats.
          </p>
          <p className="mt-4 text-sm text-muted">
            So price stays bilateral. It gets negotiated once, in private, by whoever picked up the
            phone.
          </p>
        </div>

        <div>
          <h2 className="text-2xl leading-tight">So standardise the bid instead</h2>
          <p className="mt-4 text-sm text-muted">
            A buyer does not offer for one invoice. They post a standing quote over a bucket, the
            way money-market desks have always quoted short paper:
          </p>
          <blockquote className="mt-5 border-l-2 border-accent bg-sunken px-5 py-4 font-serif text-lg italic">
            Any A-rated paper, sixty days or less, at 8% annualised, up to $200k of exposure.
          </blockquote>
          <p className="mt-4 text-sm text-muted">
            Now the assets stay unique and the <strong>buyers</strong> become fungible. Anything
            that arrives is priced immediately by reading the curve at its own rating and tenor.
            Nobody waits for a counterparty.
          </p>
        </div>
      </section>

      <section className="grid gap-8 lg:grid-cols-[1fr_20rem] lg:items-center">
        <Card className="px-6 py-6">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <h2 className="text-xl">The curve is just the bids, plotted</h2>
            <span className="text-xs text-muted">
              {mandates.filter((m) => m.status === 'active').length} funded mandates in this book
            </span>
          </div>
          <CurveStrip points={curveFrom(mandates, (m) => metaOf(m.id).name)} className="mt-4" />
          <p className="mt-4 text-sm text-muted">
            There is no model behind this line. Each point is somebody&rsquo;s standing bid with
            escrowed capital behind it, which is what makes a quote firm rather than indicative.
          </p>
        </Card>

        <div>
          <h2 className="text-2xl leading-tight">The instrument was always a bond</h2>
          <p className="mt-4 text-sm text-muted">
            A discounted invoice is bought below par and redeems at face on a fixed date, with the
            discount being the yield. That is not a metaphor — it is the same instrument, and it is
            why a receivable can be described honestly as something tradeable.
          </p>
        </div>
      </section>

      <section className="border-t border-rule pt-12">
        <h2 className="text-2xl leading-tight">Five moves</h2>
        <ol className="mt-6 grid gap-px overflow-hidden rounded-md border border-rule bg-rule md:grid-cols-5">
          <Move
            n="01"
            title="List"
            body="The invoice becomes an instrument when it is added, not when it is sold. Nobody waits on that at the moment money moves."
          />
          <Move
            n="02"
            title="Quote"
            body="Priced by reading the standing bids where it sits. A confirmed invoice carries a live price, not a button that asks for one."
          />
          <Move
            n="03"
            title="Match"
            body="Eligibility is checked before matching, so an ineligible counterparty is never matched and a refusal is an answer with a reason."
          />
          <Move
            n="04"
            title="Settle"
            body="Delivery against payment. Neither side has to move first, and buyer capital never has to leave where it already lives."
          />
          <Move
            n="05"
            title="Mature"
            body="The customer pays, and it routes to whoever holds the paper now — which is what makes this a secondary market at all."
          />
        </ol>
      </section>

      <section className="grid gap-8 border-t border-rule pt-12 md:grid-cols-3">
        <Argument title="One book, two lives">
          Seasoned paper is just shorter-tenor paper. An invoice sold at 4% on day zero lists into
          the same bids on day thirty and clears tighter, because less time remains. A buyer bids
          tighter on paper they know they can exit, so the secondary leg is what makes the first
          quote competitive.
        </Argument>

        <Argument title="Ratings are earned, not assigned">
          A customer starts unrated and their first invoice prices at the wide end. Every invoice
          they settle on time tightens it, permanently and visibly. No external source of truth
          exists for this credit, so a market in it has to manufacture its own record or price
          blind.
        </Argument>

        <Argument title="Non-recourse, and no holdback">
          A mandate is written against the customer&rsquo;s rating, so the buyer carries the loss if
          the customer does not pay. Confirmation removes dispute risk at the point of listing,
          which is what buys the seller the last fifteen per cent conventional factoring holds back.
        </Argument>
      </section>

      <section className="rounded-md border border-rule bg-raised px-8 py-10 text-center">
        <h2 className="text-2xl">Every screen here exists to make one screen true</h2>
        <p className="mx-auto mt-3 max-w-xl text-sm text-muted">
          A confirmed invoice with a price sitting next to it, that moves as the bids move and the
          due date comes closer. Nothing in invoice finance works this way today, where a price is a
          phone call and a wait.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-3">
          <Link href="/book" className={buttonClasses('primary', 'lg')}>
            Open the book
          </Link>
          <Link href="/proof/TRD-4417" className={buttonClasses('quiet', 'lg')}>
            Or see how a trade is proven
          </Link>
        </div>
      </section>
    </div>
  );
}

function Move({ n, title, body }: { n: string; title: string; body: string }) {
  return (
    <li className="bg-raised px-5 py-5">
      <span className="num text-xs text-accent" data-num>
        {n}
      </span>
      <h3 className="mt-2 text-base">{title}</h3>
      <p className="mt-2 text-xs text-muted">{body}</p>
    </li>
  );
}

function Argument({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <h3 className="text-lg leading-snug">{title}</h3>
      <p className="mt-3 text-sm text-muted">{children}</p>
    </div>
  );
}
