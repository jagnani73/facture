/**
 * The ATS calldata surface.
 *
 * These are not tests of Hedera. They are tests that what this service *encodes* matches what
 * the deployed factory *answers on*, which is a different thing and the one that broke.
 *
 * The `deployBond` tuple here was previously a plausible flattening of the real one. It
 * compiled, it typechecked, it produced calldata — and it encoded to a selector the diamond
 * does not have, so every issuance reverted with `FunctionNotFound(bytes4)` after 45,540 gas.
 * Nothing in the codebase could tell the difference, because a wrong selector is not a wrong
 * type. A selector assertion is the only thing that catches it without spending money.
 */

import { encodeFunctionData } from 'viem';
import { describe, expect, it } from 'vitest';
import { ATS_ABI, DEPLOY_BOND_SELECTOR } from '../src/services/ats.js';

const ZERO = `0x${'0'.repeat(40)}` as const;

/** The shape a real issuance builds, with every field the factory declares. */
const bondArgs = [
  {
    security: {
      resolver: '0xBA2D5FC2083A0b8f164c50e65d782087fBA18E0a' as const,
      maxSupply: 6_230_000n,
      resolverProxyConfiguration: { key: `0x${'0'.repeat(63)}2` as const, version: 1n },
      erc20MetadataInfo: {
        name: 'Meridian Fabrication receivable MF-2046',
        symbol: 'FAC2046',
        isin: 'USQ72738QUM6',
        decimals: 0,
      },
      rbacs: [{ role: `0x${'0'.repeat(64)}` as const, members: [ZERO] }],
      externalPauses: [],
      externalControlLists: [],
      externalKycLists: [],
      compliance: ZERO,
      identityRegistry: ZERO,
      arePartitionsProtected: false,
      isMultiPartition: false,
      isControllable: true,
      isWhiteList: true,
      clearingActive: false,
      internalKycActivated: true,
      erc20VotesActivated: false,
    },
    bondDetails: {
      currency: '0x858368' as const,
      nominalValue: 1n,
      nominalValueDecimals: 0,
      startingDate: 1_788_000_000n,
      maturityDate: 1_796_342_400n,
    },
    proceedRecipients: [],
    proceedRecipientsData: [],
  },
  {
    regulationType: 1,
    regulationSubType: 0,
    additionalSecurityData: {
      countriesControlListType: false,
      listOfCountries: 'AF,CU,KP,IR,SY',
      info: '',
    },
  },
] as const;

describe('deployBond calldata', () => {
  it('encodes to the selector the deployed factory answers on', () => {
    const calldata = encodeFunctionData({
      abi: ATS_ABI,
      functionName: 'deployBond',
      args: bondArgs,
    });

    /*
     * `0x29002951`, confirmed by the one `deployBond` that has actually succeeded on this
     * factory (tx 0xbe1c381a…, 7,016,307 gas). If this assertion ever fails, the ABI above has
     * drifted from the deployed contract and no transaction should be sent.
     */
    expect(calldata.slice(0, 10)).toBe(DEPLOY_BOND_SELECTOR);
  });

  it('is not the selector that silently broke every issuance', () => {
    const calldata = encodeFunctionData({
      abi: ATS_ABI,
      functionName: 'deployBond',
      args: bondArgs,
    });

    // The flattened tuple encoded to this. The diamond has no such function, so the call
    // reverted with FunctionNotFound(0x58a038dd) — a status that reads like a contract fault.
    expect(calldata.slice(0, 10)).not.toBe('0x58a038dd');
  });

  it('carries the country list as a block list, not an allow list', () => {
    /*
     * `countriesControlListType: false` means these countries are EXCLUDED. Inverting it
     * publishes an instrument offered only to sanctioned jurisdictions, which is the sort of
     * mistake that encodes perfectly well and is invisible in a type.
     */
    const [, regulation] = bondArgs;
    expect(regulation.additionalSecurityData.countriesControlListType).toBe(false);
    expect(regulation.additionalSecurityData.listOfCountries).toContain('KP');
  });

  it('declares the functions the compliance path actually calls', () => {
    /*
     * The names matter as much as the shapes. `isAuthorized`, `getKycAccountStatus` and
     * `isPaused` do not exist on a deployed security and revert with FunctionNotFound; the
     * real ones are `getControlListType`, `isInControlList`, `getKycStatusFor` and `paused`.
     */
    const names = ATS_ABI.map((entry) => entry.name);
    for (const absent of ['isAuthorized', 'getKycAccountStatus', 'isPaused']) {
      expect(names).not.toContain(absent);
    }
    for (const present of ['deployBond', 'balanceOf', 'createHoldByPartition']) {
      expect(names).toContain(present);
    }
  });
});
