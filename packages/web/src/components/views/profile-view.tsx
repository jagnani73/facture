'use client';

import { useEffect, useMemo, useState } from 'react';

import { explorerAddressUrl, explorerTxUrl, PARTY_ROLES, type PartyRole } from '@/lib/domain';
import { usePartyProfile } from '@/lib/auth/use-party-profile';
import { draftFrom, validateDraft, type ProfileDraft, type ProfileProblem } from '@/lib/party';
import { Failure, Pending } from '@/components/ui/async';
import {
  Card,
  CardHead,
  Field,
  Label,
  PageHeader,
  TextInput,
  buttonClasses,
} from '@/components/ui/primitives';

/**
 * Who you are on this venue, in your own words and your own signature.
 *
 * Everything else public in this product was written by Facture. The uniqueness registry records
 * the venue's claim, the invoice registry records the venue's listing, and `MandateBook` records
 * the venue as the buyer of every standing bid because the funders behind them hold no Hedera key.
 * This page is the exception: the record is recovered from an EIP-712 signature, so what lands on
 * chain is what **you** said, and the venue only pays for the transaction.
 *
 * That is worth saying on the screen rather than only in a comment, because it is the difference
 * between a profile and a form — and it is why there is a signature step at all when a text box
 * and a database column would have been less work.
 *
 * ## Roles are a claim, and the copy must not imply otherwise
 *
 * Picking "buyer" does not grant anything. Capital is the Arc vault's, eligibility to hold paper is
 * each instrument's own `ControlList` and `Kyc`, and every real capability is checked by whatever
 * grants it. What a role does is tell the venue which records to open and which screens to show.
 */

const ROLE_COPY: Record<PartyRole, { title: string; blurb: string }> = {
  seller: {
    title: 'I sell receivables',
    blurb:
      'You list invoices your customers owe you and take a price from whichever standing bid fits. ' +
      'Opens the book.',
  },
  buyer: {
    title: 'I fund them',
    blurb:
      'You write a mandate — a rating floor, a maximum tenor, a rate — fund it, and anything that ' +
      'fits comes to you. Opens mandates.',
  },
};

const EMPTY: ProfileDraft = {
  roles: [],
  displayName: '',
  legalName: '',
  country: '',
  websiteUri: '',
};

export function ProfileView() {
  const { state, save, address, submit, reload } = usePartyProfile();
  const [draft, setDraft] = useState<ProfileDraft>(EMPTY);
  const [touched, setTouched] = useState(false);

  const recorded = state.status === 'ready' ? state.lookup.profile : null;

  /*
   * Load the record into the form once, and stop. Re-seeding on every render would discard what
   * somebody is halfway through typing the moment a background read resolved — and this hook
   * deliberately re-reads after every save, so that is not hypothetical.
   */
  useEffect(() => {
    if (recorded === null || touched) return;
    setDraft(draftFrom(recorded));
  }, [recorded, touched]);

  /*
   * What the contract would refuse, computed once and read two ways.
   *
   * `problems` stays suppressed until somebody has typed, because marking an empty form red before
   * it has been touched tells a first-time visitor they have already got it wrong. But the BUTTON
   * is disabled off the same list from the very first render, and those two together produced the
   * one state this screen had no answer for: a new party arriving at an empty form, a dead "Sign
   * and publish", and not one word anywhere saying what it is waiting for. Silence reads as a
   * broken page, and a broken page is not something a person retries.
   *
   * So the outstanding requirements are also said in a sentence beside the button — see
   * {@link stillNeeded} — which is the half that was missing. The validation itself is untouched:
   * the fix is telling somebody what is required, not letting them sign something the registry
   * would reject.
   */
  const outstanding = useMemo(() => validateDraft(draft), [draft]);
  const problems = touched ? outstanding : [];
  const problemFor = (field: keyof ProfileDraft) =>
    problems.find((p) => p.field === field)?.message;

  const edit = (patch: Partial<ProfileDraft>) => {
    setTouched(true);
    setDraft((current) => ({ ...current, ...patch }));
  };

  const toggleRole = (role: PartyRole) => {
    setTouched(true);
    setDraft((current) => ({
      ...current,
      roles: current.roles.includes(role)
        ? current.roles.filter((r) => r !== role)
        : [...current.roles, role],
    }));
  };

  if (state.status === 'unavailable') {
    return (
      <div className="space-y-8">
        <Header recorded={null} />
        <Card className="px-5 py-8">
          <p className="max-w-xl text-sm text-muted">
            Sign-in is not configured on this deployment, so there is no wallet to sign a profile
            with. The screens fall back to the shared demo account.
          </p>
        </Card>
      </div>
    );
  }

  if (state.status === 'no-wallet') {
    return (
      <div className="space-y-8">
        <Header recorded={null} />
        <Card className="px-5 py-8">
          <p className="max-w-xl text-sm text-muted">
            Sign in first. A profile belongs to the address that signed it, so there has to be a
            wallet before there is anything to say.
          </p>
        </Card>
      </div>
    );
  }

  if (state.status === 'loading') {
    return (
      <div className="space-y-8">
        <Header recorded={null} />
        <Pending what="your profile" lines={4} />
      </div>
    );
  }

  if (state.status === 'failed') {
    return (
      <div className="space-y-8">
        <Header recorded={null} />
        <Failure error={state.message} what="your profile" onRetry={reload} />
      </div>
    );
  }

  const { lookup } = state;
  const busy = save.status === 'signing' || save.status === 'relaying';
  const blocked = outstanding.length > 0;

  return (
    <div className="space-y-8">
      <Header recorded={recorded} />

      {/*
        Three states, never two. A registry nobody wired and a node that would not answer are
        different from "you have not written one yet", and printing the third where one of the
        first two is true would be a confident absence nobody established.
      */}
      {!lookup.checked ? (
        <Card className="border-warn/40 bg-warn-wash px-5 py-4" role="status">
          <Label className="mb-1">Registry unreadable</Label>
          <p className="max-w-3xl text-sm text-ink">
            The venue could not reach the party registry just now, so it cannot say whether you have
            a record on it. Your details are still safe here — this affects the public copy only.
          </p>
        </Card>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-[1fr_22rem]">
        <Card>
          <CardHead
            title={recorded ? 'Your details' : 'Introduce your business'}
            hint="You sign this. The venue pays to publish it and cannot change a word."
          />

          <div className="space-y-6 px-5 py-5">
            <fieldset>
              <legend className="label-micro mb-2.5">What you do here</legend>
              <div className="grid gap-2.5 sm:grid-cols-2">
                {PARTY_ROLES.map((role) => {
                  const on = draft.roles.includes(role);
                  return (
                    <button
                      key={role}
                      type="button"
                      onClick={() => toggleRole(role)}
                      aria-pressed={on}
                      className={[
                        'rounded-xs border px-4 py-3 text-left transition-colors',
                        on
                          ? 'border-accent bg-accent-wash'
                          : 'border-rule hover:border-rule-strong',
                      ].join(' ')}
                    >
                      <span className="block text-sm font-medium text-ink">
                        {ROLE_COPY[role].title}
                      </span>
                      <span className="mt-1 block text-xs text-muted">{ROLE_COPY[role].blurb}</span>
                    </button>
                  );
                })}
              </div>
              {/*
                Both is an ordinary thing to be, and the contract stores a set rather than a
                choice precisely so nobody has to pick a side they do not occupy.
              */}
              <p className="mt-2 text-xs text-muted">
                Pick both if you do both. Neither grants you anything — capital and eligibility are
                checked where they always were.
              </p>
              {problemFor('roles') ? (
                <p className="mt-1.5 text-xs text-neg">{problemFor('roles')}</p>
              ) : null}
            </fieldset>

            <Field
              label="Business name"
              htmlFor="displayName"
              hint={
                problemFor('displayName') ??
                'What counterparties see. Goes on chain as you type it.'
              }
            >
              <TextInput
                id="displayName"
                value={draft.displayName}
                onChange={(e) => edit({ displayName: e.target.value })}
                placeholder="Meridian Fabrication"
                aria-invalid={problemFor('displayName') !== undefined}
              />
            </Field>

            <div className="grid gap-4 sm:grid-cols-[1fr_8rem]">
              <Field
                label="Registered name"
                htmlFor="legalName"
                hint={problemFor('legalName') ?? 'Optional. The entity name, if it differs.'}
              >
                <TextInput
                  id="legalName"
                  value={draft.legalName}
                  onChange={(e) => edit({ legalName: e.target.value })}
                  placeholder="Meridian Fabrication Ltd"
                />
              </Field>

              <Field
                label="Country"
                htmlFor="country"
                hint={problemFor('country') ?? 'Two letters.'}
              >
                <TextInput
                  id="country"
                  value={draft.country}
                  onChange={(e) => edit({ country: e.target.value.toUpperCase() })}
                  placeholder="GB"
                  maxLength={2}
                  aria-invalid={problemFor('country') !== undefined}
                />
              </Field>
            </div>

            <Field
              label="Website"
              htmlFor="websiteUri"
              hint={
                problemFor('websiteUri') ?? 'Optional. Published as a claim, not a verification.'
              }
            >
              <TextInput
                id="websiteUri"
                value={draft.websiteUri}
                onChange={(e) => edit({ websiteUri: e.target.value })}
                placeholder="https://meridian.example"
              />
            </Field>

            <div className="flex flex-wrap items-center gap-3 border-t border-rule pt-5">
              <button
                type="button"
                disabled={busy || blocked}
                onClick={() => {
                  setTouched(true);
                  void submit(draft);
                }}
                className={buttonClasses('primary')}
              >
                {save.status === 'signing'
                  ? 'Check your wallet…'
                  : save.status === 'relaying'
                    ? 'Publishing…'
                    : recorded
                      ? 'Sign and update'
                      : 'Sign and publish'}
              </button>
              {/*
                Why the button is dead, whenever it is dead — not only once somebody has typed.
                A disabled control with no reason beside it is the page telling a new party
                nothing at all, which is how the first visit read.
              */}
              <p className="text-xs text-muted">
                {blocked
                  ? stillNeeded(outstanding)
                  : 'No gas, no HBAR. Signing is free; the venue pays to put it on chain.'}
              </p>
            </div>

            <SaveNotice save={save} />
          </div>
        </Card>

        <div className="space-y-5">
          <Card>
            <CardHead title="On chain" hint="What a counterparty can read without asking us." />
            <div className="space-y-3 px-5 py-4 text-sm">
              {address ? (
                <div>
                  <Label>Your address</Label>
                  <a
                    href={explorerAddressUrl('arc-testnet', address)}
                    target="_blank"
                    rel="noreferrer"
                    className="num mt-1 block break-all text-xs text-muted hover:text-ink"
                  >
                    {address}
                  </a>
                </div>
              ) : null}

              {lookup.checked && recorded ? (
                <>
                  <div>
                    <Label>Recorded</Label>
                    <p className="mt-1 text-xs text-muted">
                      {new Date(recorded.updatedAt).toLocaleString()} · edit {recorded.nonce + 1}
                    </p>
                  </div>
                  {/*
                    A role bit this build does not know is rendered rather than dropped. Showing
                    fewer roles than somebody signed for would present an answer we could not read
                    as one we could.
                  */}
                  {recorded.unknownRoleBits !== 0 ? (
                    <p className="text-xs text-warn">
                      This record also claims a role this version of the app does not recognise.
                    </p>
                  ) : null}
                </>
              ) : lookup.checked ? (
                <p className="text-xs text-muted">
                  Nothing recorded yet. Publishing writes your first version.
                </p>
              ) : (
                <p className="text-xs text-muted">The registry could not be read.</p>
              )}

              {lookup.signing ? (
                <div className="border-t border-rule pt-3">
                  <Label>Registry</Label>
                  <a
                    href={explorerAddressUrl('hedera-testnet', lookup.signing.contractAddress)}
                    target="_blank"
                    rel="noreferrer"
                    className="num mt-1 block break-all text-xs text-muted hover:text-ink"
                  >
                    {lookup.signing.contractAddress}
                  </a>
                </div>
              ) : null}
            </div>
          </Card>

          <Card className="px-5 py-4">
            <Label className="mb-1.5">Why you sign this</Label>
            <p className="text-xs text-muted">
              The registry writes whichever address the signature belongs to. Facture submits the
              transaction and pays for it, and could not publish a different name under your address
              if it tried — so the record is yours rather than ours about you.
            </p>
          </Card>
        </div>
      </div>
    </div>
  );
}

/**
 * What each field wants, as a noun phrase, in the order the form asks for it.
 *
 * Deliberately not `validateDraft`'s own messages. Those are corrections — *"A business needs a
 * name here."* — and they belong beside the field they correct, where the reader has just done
 * something. Repeated next to the button on a form nobody has touched they read as a list of
 * mistakes somebody has not made yet, which is the tone this screen can least afford at the one
 * moment it is talking to a stranger.
 */
const NEEDED: Record<keyof ProfileDraft, string> = {
  roles: 'what you do here',
  displayName: 'a business name',
  legalName: 'a shorter registered name',
  country: 'a two-letter country, or none',
  websiteUri: 'a shorter website',
};

/** The outstanding requirements as one sentence, so a disabled button is never unexplained. */
function stillNeeded(problems: readonly ProfileProblem[]): string {
  const order = Object.keys(NEEDED) as (keyof ProfileDraft)[];
  const wanted = order
    .filter((field) => problems.some((p) => p.field === field))
    .map((f) => NEEDED[f]);

  const list =
    wanted.length <= 1
      ? (wanted[0] ?? 'a little more')
      : `${wanted.slice(0, -1).join(', ')} and ${wanted[wanted.length - 1]}`;

  return `Still needed before you can sign: ${list}.`;
}

function Header({ recorded }: { recorded: { displayName: string } | null }) {
  return (
    <PageHeader
      {...(recorded ? { eyebrow: recorded.displayName } : {})}
      title="Your profile"
      lede="What this venue calls you, and what a counterparty reads off the chain. You sign it; we publish it."
    />
  );
}

/**
 * What became of a save.
 *
 * Four labels, and they do not map one-to-one onto the API's four states.
 *
 * The venue answers `recorded | refused | unavailable | not-configured`. This screen prints
 * **Published** for the first and **Saved here only** for the other three, because the party's next
 * action is the same in all three: nothing was lost, and the venue's own record stands. Which of
 * the three it was is carried by `recording.detail`, the venue's sentence, rather than by a
 * different card. The other two labels belong to a failure that never reached a `recording` at all:
 * **Not saved** when the venue answered and refused, **Outcome unknown** when it did not answer.
 *
 * An earlier version of this comment said "four outcomes, not two", which described
 * `ProfileRecording` rather than anything this component does with it.
 */
function SaveNotice({ save }: { save: ReturnType<typeof usePartyProfile>['save'] }) {
  if (save.status === 'idle' || save.status === 'signing' || save.status === 'relaying')
    return null;

  /*
   * "Not saved" is a claim, and it is only available when the venue actually answered. A relay
   * that timed out may have reached the registry and then failed to say so, and labelling that
   * red would send somebody to re-sign a nonce that has already moved — the loop this screen
   * was in until the hook started re-reading on the way out. Warn, and name the uncertainty.
   */
  if (save.status === 'failed') {
    const sure = save.outcome === 'not-saved';
    return (
      <div
        className={[
          'rounded-xs border px-4 py-3',
          sure ? 'border-neg/45 bg-neg-wash' : 'border-warn/45 bg-warn-wash',
        ].join(' ')}
        role="alert"
      >
        <Label className="mb-1">{sure ? 'Not saved' : 'Outcome unknown'}</Label>
        <p className="text-sm text-ink">{save.message}</p>
      </div>
    );
  }

  const { recording } = save.result;
  const good = recording.state === 'recorded';

  return (
    <div
      className={[
        'rounded-xs border px-4 py-3',
        good ? 'border-pos/45 bg-pos-wash' : 'border-warn/45 bg-warn-wash',
      ].join(' ')}
      role="status"
    >
      <Label className="mb-1">{good ? 'Published' : 'Saved here only'}</Label>
      <p className="text-sm text-ink">{recording.detail}</p>
      {recording.transactionHash ? (
        <a
          href={explorerTxUrl('hedera-testnet', recording.transactionHash)}
          target="_blank"
          rel="noreferrer"
          className="num mt-2 block text-xs text-muted hover:text-ink"
        >
          {recording.transactionHash}
        </a>
      ) : null}
    </div>
  );
}
