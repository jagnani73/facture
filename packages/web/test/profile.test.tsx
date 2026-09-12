/**
 * The one record in this product the venue does not author.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════
 * WHAT THESE TESTS CAN PROVE, AND WHAT ONLY A LOGIN CAN
 * ═══════════════════════════════════════════════════════════════════════════════════════
 *
 * Privy's signing round trip needs a real session and is not simulated, exactly as in
 * `claim-payout.test.tsx`. What sits either side of it is, because that is where this screen's
 * risk actually is:
 *
 * - **Which wallet the profile belongs to.** `useWallets()` returns injected wallets as well as
 *   the one Privy made, and this page read `wallets[0]` until it was opened in a browser with
 *   MetaMask connected to localhost. It then offered to publish a profile for an address with no
 *   Privy session behind it, and the venue would have refused the relay after the form was filled
 *   in and signed. Found in a browser, fixed, and pinned here — every other test signs in cleanly
 *   and none of them has a second wallet lying around.
 * - **That it refuses to sign against a guess.** A nonce is the contract's answer, and a signature
 *   over a guessed one recovers correctly and is then refused by `PartyRegistry` for a reason
 *   nothing on screen can explain. Nothing but these tests stops a later edit defaulting it to
 *   `'0'`, which would work on a party's first ever save and fail on every one after it.
 * - **That a 200 is not "it is on chain".** The venue relays and then reports what happened in
 *   `recording.state`; reading the status code alone tells somebody their profile is public when
 *   only the venue's copy is.
 *
 * The signature itself is Privy's contract with itself. The digest it would be over is pinned as a
 * literal in `party.test.ts`.
 */

import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PartyLookup, ProfileSaved } from '@/lib/api/contract';
import type { SaveState } from '@/lib/auth/use-party-profile';
import { ApiError } from '@/lib/api/problem';

/* ── the Privy seam ──────────────────────────────────────────────────────────────────── */

interface FakeWallet {
  address: string;
  walletClientType: string;
  connectorType: string;
  imported?: boolean;
}

const signTypedData = vi.fn();
let privy = { ready: true, authenticated: true };
let wallets: FakeWallet[] = [];
let identityToken: string | null = 'identity-token';

vi.mock('@privy-io/react-auth', () => ({
  usePrivy: () => privy,
  useWallets: () => ({ wallets }),
  useIdentityToken: () => ({ identityToken }),
  useSignTypedData: () => ({ signTypedData }),
  /*
   * Privy's own rule, restated rather than invented: the shipped bundle selects
   * `walletClientType === 'privy' && connectorType === 'embedded' && !imported`. It is written out
   * because this fake stands in for Privy, not for the code under test — what is being asserted is
   * that the hook asks for the embedded wallet at all. A regression to `wallets[0]` gets the
   * injected one back from this fake and the test fails, which is the whole point of feeding it
   * two wallets in a deliberate order.
   */
  getEmbeddedConnectedWallet: (list: readonly FakeWallet[]) =>
    list.find(
      (w) => w.walletClientType === 'privy' && w.connectorType === 'embedded' && !w.imported,
    ) ?? null,
}));

const getParty = vi.fn();
const saveProfile = vi.fn();

vi.mock('@/lib/api/client', () => ({ api: { getParty, saveProfile } }));
vi.mock('@/lib/api/config', () => ({ signInAvailable: () => true }));

const { ProfileView } = await import('@/components/views/profile-view');
const { usePartyProfile } = await import('@/lib/auth/use-party-profile');

/* ── fixtures ────────────────────────────────────────────────────────────────────────── */

/** The wallet Privy made from an email. Everything on this screen is about this address. */
const EMBEDDED = '0xe52553bd1b0D869b9310E2Ff04a8F5DC58dcE324';
/** Somebody's MetaMask, connected to localhost and nothing to do with this session. */
const INJECTED = '0x1C755e95CB11E5D5aF498bb0EA595b56e1adb035';
const REGISTRY = '0x1c9882714e1ae2555531e1a7eb4e83ebeca8b2ca';
const TX = `0x${'7c'.repeat(32)}`;

const embedded = (address = EMBEDDED): FakeWallet => ({
  address,
  walletClientType: 'privy',
  connectorType: 'embedded',
});

const injected = (address = INJECTED): FakeWallet => ({
  address,
  walletClientType: 'metamask',
  connectorType: 'injected',
});

const lookup = (over: Partial<PartyLookup> = {}): PartyLookup => ({
  address: EMBEDDED,
  checked: true,
  profile: null,
  venueName: 'Meridian Fabrication',
  nonce: '0',
  signing: {
    domain: {
      name: 'Facture Party Registry',
      version: '1',
      chainId: 296,
      verifyingContract: REGISTRY,
    },
    contractAddress: REGISTRY,
  },
  ...over,
});

const saved = (
  state: ProfileSaved['recording']['state'],
  over: Partial<ProfileSaved['recording']> = {},
): ProfileSaved => ({
  address: EMBEDDED,
  roles: ['seller'],
  displayName: 'Meridian Fabrication',
  recording: {
    state,
    transactionHash: state === 'recorded' ? TX : null,
    detail:
      state === 'recorded'
        ? 'Recorded on Hedera testnet.'
        : 'The mirror node did not answer, so the public copy was not written.',
    ...over,
  },
  sellerId: null,
  buyerId: null,
});

beforeEach(() => {
  signTypedData.mockReset();
  signTypedData.mockResolvedValue({ signature: `0x${'ab'.repeat(65)}` });
  getParty.mockReset();
  getParty.mockResolvedValue(lookup());
  saveProfile.mockReset();
  saveProfile.mockResolvedValue(saved('recorded'));
  privy = { ready: true, authenticated: true };
  wallets = [embedded()];
  identityToken = 'identity-token';
});

afterEach(cleanup);

/* ── driving the form ────────────────────────────────────────────────────────────────── */

const signButton = () => screen.getByRole('button', { name: /^Sign and (publish|update)$/ });

async function openForm() {
  render(<ProfileView />);
  await screen.findByRole('button', { name: /^Sign and (publish|update)$/ });
}

/** The least a party can say that the registry would accept: one role and a name. */
function fillValidDraft(name = 'Meridian Fabrication') {
  fireEvent.click(screen.getByRole('button', { name: /I sell receivables/ }));
  fireEvent.change(screen.getByLabelText('Business name'), { target: { value: name } });
}

/** Open, fill, press. The sequence every test below needs before it can assert anything. */
async function signAndPublish() {
  await openForm();
  fillValidDraft();
  fireEvent.click(signButton());
}

/* ── which wallet a profile belongs to ───────────────────────────────────────────────── */

describe('which wallet a profile belongs to', () => {
  /*
   * The injected wallet is first in the list on purpose. It is where `wallets[0]` would land, and
   * it is what a browser with MetaMask open actually hands this page.
   */
  it('reads the record for the embedded wallet, not the first connected one', async () => {
    wallets = [injected(), embedded()];
    render(<ProfileView />);

    await vi.waitFor(() => expect(getParty).toHaveBeenCalled());
    expect(getParty.mock.calls[0]?.[0]).toBe(EMBEDDED);
  });

  /*
   * The half that costs something. A profile read for the wrong address is a wasted request; a
   * profile SIGNED for the wrong address is a record under a key with no session behind it, which
   * the venue refuses to relay after the person has filled in the form and signed.
   */
  it('signs as the embedded wallet, whatever else is connected', async () => {
    wallets = [injected(), embedded()];
    await signAndPublish();

    await vi.waitFor(() => expect(signTypedData).toHaveBeenCalledTimes(1));
    const [payload, options] = signTypedData.mock.calls[0] as [
      { message: { party: string } },
      { address: string },
    ];
    expect(payload.message.party).toBe(EMBEDDED);
    expect(options.address).toBe(EMBEDDED);

    await vi.waitFor(() => expect(saveProfile).toHaveBeenCalledTimes(1));
    const relayed = saveProfile.mock.calls[0]?.[1] as { update: { party: string } };
    expect(relayed.update.party).toBe(EMBEDDED);
  });

  /*
   * Wallets present and nobody signed in. The venue authenticates a relay by identity token rather
   * than by address, so an address nobody signed in as cannot produce one — and offering the form
   * there is offering a signature that cannot be relayed.
   */
  it('offers no form at all to a session Privy has not authenticated', async () => {
    privy = { ready: true, authenticated: false };
    wallets = [injected(), embedded()];
    render(<ProfileView />);

    expect(await screen.findByText(/Sign in first/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Sign and/ })).toBeNull();
    expect(getParty).not.toHaveBeenCalled();
  });
});

/* ── refusing to sign against a guess ────────────────────────────────────────────────── */

/** Render, fill, press, and return the refusal — cleaning up so two can be compared in one test. */
async function refusalFor(state: PartyLookup): Promise<string> {
  getParty.mockResolvedValue(state);
  await signAndPublish();
  const message = (await screen.findByRole('alert')).textContent ?? '';
  cleanup();
  return message;
}

describe('it refuses to sign against a guess', () => {
  it('will not sign when the deployment has no registry to sign against', async () => {
    const message = await refusalFor(lookup({ signing: null, nonce: null, checked: false }));

    expect(message).toMatch(/no party registry wired/i);
    expect(signTypedData).not.toHaveBeenCalled();
  });

  /**
   * THE ONE THAT MATTERS. A nonce is the contract's answer to "what must the next signature
   * carry", and nothing in the type system stops a later edit writing `lookup.nonce ?? '0'` to
   * make this case go away. That would work on a party's very first save and be refused on every
   * one after it, with the screen unable to say why.
   */
  it('will not sign against a nonce it could not read', async () => {
    const message = await refusalFor(lookup({ nonce: null, checked: false }));

    expect(message).toMatch(/nonce/i);
    expect(signTypedData).not.toHaveBeenCalled();
  });

  /* Two facts, two fixes: one is a deployment without a registry, the other is a node that
   * blinked and will answer in a moment. Collapsing them sends the reader to the wrong one. */
  it('does not give the two the same words', async () => {
    const noRegistry = await refusalFor(lookup({ signing: null, nonce: null, checked: false }));
    const noNonce = await refusalFor(lookup({ nonce: null, checked: false }));

    expect(noRegistry).not.toBe(noNonce);
  });
});

/* ── a 200 is not "it is on chain" ───────────────────────────────────────────────────── */

describe('what became of a save', () => {
  it('says "Published" with the transaction once the chain took it', async () => {
    await signAndPublish();

    expect(await screen.findByText('Published')).toBeTruthy();
    expect(screen.getByText('Recorded on Hedera testnet.')).toBeTruthy();
    expect(screen.getByRole('link', { name: TX }).getAttribute('href')).toContain(TX);
  });

  /*
   * The venue's own record is written either way, so this is not a failure — but it is not a
   * publication either, and the difference is the whole reason `recording.state` exists.
   */
  it('says "Saved here only" when the venue could not reach the registry', async () => {
    saveProfile.mockResolvedValue(saved('unavailable'));
    await signAndPublish();

    expect(await screen.findByText('Saved here only')).toBeTruthy();
    expect(screen.queryByText('Published')).toBeNull();
    expect(screen.getByText(/mirror node did not answer/)).toBeTruthy();
  });

  /* A refusal is the party's to fix by signing again, and it is emphatically not a publication. */
  it('does not read a contract refusal as a publication', async () => {
    saveProfile.mockResolvedValue(
      saved('refused', { detail: 'The registry refused the signature.' }),
    );
    await signAndPublish();

    expect(await screen.findByText('Saved here only')).toBeTruthy();
    expect(screen.queryByText('Published')).toBeNull();
  });
});

/* ── a failed save, and the nonce underneath it ──────────────────────────────────────── */

describe('a save that did not come back', () => {
  /**
   * The retry loop this screen used to be in.
   *
   * The venue relays to the registry and then answers, so a proxy 504 or a 500 raised after the
   * chain write arrives here with the nonce already spent. Re-reading only on success left every
   * retry re-signing a stale nonce — refused by the contract, with the refusal saying signing
   * again resolves it, which was false until the page was reloaded.
   */
  it('re-reads the registry, because a failure is when the nonce has most likely moved', async () => {
    saveProfile.mockRejectedValue(
      new ApiError({ code: 'unreachable', status: 0, title: 'No answer' }),
    );
    await signAndPublish();

    await screen.findByText('Outcome unknown');
    await vi.waitFor(() => expect(getParty).toHaveBeenCalledTimes(2));
  });

  /* "Not saved" is a claim, and a venue that never answered is not in a position to make it. */
  it('says the outcome is unknown rather than claiming nothing was saved', async () => {
    saveProfile.mockRejectedValue(
      new ApiError({ code: 'unreachable', status: 0, title: 'No answer' }),
    );
    await signAndPublish();

    const notice = await screen.findByRole('alert');
    expect(notice.textContent).toMatch(/timeout is not a rollback/i);
    expect(screen.queryByText('Not saved')).toBeNull();
  });

  /*
   * A 4xx is the venue answering: it read the request, declined it, and knows nothing was
   * relayed. Its sentence is the one to show, and "Not saved" is true.
   */
  it('still says "Not saved" when the venue answered and declined', async () => {
    saveProfile.mockRejectedValue(
      new ApiError({
        code: 'validation_failed',
        status: 422,
        title: 'Refused',
        detail: 'That signature does not match the nonce on file.',
      }),
    );
    await signAndPublish();

    expect(await screen.findByText('Not saved')).toBeTruthy();
    expect(screen.getByText(/does not match the nonce on file/)).toBeTruthy();
    await vi.waitFor(() => expect(getParty).toHaveBeenCalledTimes(2));
  });
});

/* ── a form nobody has filled in yet ─────────────────────────────────────────────────── */

describe('a form nobody has filled in yet', () => {
  /**
   * The first visit, which had no answer at all. An empty draft fails validation, so the button
   * is disabled from the first render — while the field-level messages stay suppressed until
   * somebody has typed, which is right. Together they produced a dead button and silence, and
   * silence reads as a broken page rather than as an unfinished form.
   */
  it('says what is still needed rather than disabling in silence', async () => {
    await openForm();

    expect((signButton() as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Still needed before you can sign/)).toBeTruthy();
    expect(screen.getByText(/what you do here and a business name/)).toBeTruthy();
  });

  /* Saying what is wanted is not the same as marking an untouched form wrong. */
  it('does not correct a form nobody has touched', async () => {
    await openForm();

    expect(screen.queryByText('A business needs a name here.')).toBeNull();
    expect(screen.queryByText(/A profile that claims nothing says nothing/)).toBeNull();
  });

  it('names only what is outstanding once one of the two is given', async () => {
    await openForm();
    fireEvent.click(screen.getByRole('button', { name: /I sell receivables/ }));

    const note = screen.getByText(/Still needed before you can sign/);
    expect(note.textContent).toMatch(/a business name/);
    expect(note.textContent).not.toMatch(/what you do here/);
  });

  it('gives the button back, and the ordinary note with it', async () => {
    await openForm();
    fillValidDraft();

    expect((signButton() as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText(/No gas, no HBAR/)).toBeTruthy();
    expect(screen.queryByText(/Still needed before you can sign/)).toBeNull();
  });
});

/* ── a draft the encoder cannot take ─────────────────────────────────────────────────── */

function failedSave(save: SaveState): { message: string } {
  if (save.status !== 'failed') throw new Error(`expected a failed save, got ${save.status}`);
  return save;
}

/**
 * Driven through the hook rather than the screen, deliberately.
 *
 * `rolesToBitmask` throws on an empty role set and `countryToBytes2` throws on anything that is
 * not two letters, and the only thing standing between them and a user is a disabled button — a
 * guard that is load-bearing because some other constraint happens to hold, which this codebase
 * has paid for repeatedly. Reaching the state through the form is impossible by construction,
 * which is exactly why the hook is asked directly.
 */
describe('a draft the encoder cannot take', () => {
  async function submitting(draft: {
    roles: ('seller' | 'buyer')[];
    displayName: string;
    legalName: string;
    country: string;
    websiteUri: string;
  }) {
    const { result } = renderHook(() => usePartyProfile());
    await vi.waitFor(() => expect(result.current.state.status).toBe('ready'));
    await act(async () => {
      await result.current.submit(draft);
    });
    return result;
  }

  const base = {
    roles: ['seller'] as ('seller' | 'buyer')[],
    displayName: 'Meridian',
    legalName: '',
    country: '',
    websiteUri: '',
  };

  it('reports an empty role set as a failed save, not an unhandled rejection', async () => {
    const result = await submitting({ ...base, roles: [] });

    expect(result.current.save.status).toBe('failed');
    expect(failedSave(result.current.save).message).toMatch(/at least one role/i);
    expect(signTypedData).not.toHaveBeenCalled();
  });

  it('reports a country code the contract could not store the same way', async () => {
    const result = await submitting({ ...base, country: 'GBR' });

    expect(result.current.save.status).toBe('failed');
    expect(failedSave(result.current.save).message).toMatch(/country code/i);
    expect(signTypedData).not.toHaveBeenCalled();
  });

  /* Nothing left the browser, so this one CAN say so flatly. */
  it('knows nothing was saved, because nothing was sent', async () => {
    const result = await submitting({ ...base, roles: [] });

    expect(result.current.save).toMatchObject({ outcome: 'not-saved' });
  });
});
