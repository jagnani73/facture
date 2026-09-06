// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {IComplianceGate} from "./interfaces/IComplianceGate.sol";
import {IAtsControlList, IAtsKyc, IAtsPause} from "./interfaces/ats/IAtsFacets.sol";
import {ReasonCodes} from "./libraries/ReasonCodes.sol";

/**
 * @title AtsComplianceGate
 * @notice Asks an ATS security's OWN facets whether a buyer may hold it, before any match is struck.
 *
 * @dev ------------------------------------------------------------------------------------------
 *      WHY `ControlList` AND `Kyc`, AND NOT THE ERC-3643 `IdentityRegistry`
 *      ------------------------------------------------------------------------------------------
 *
 *      ATS securities can be wired to an ERC-3643 `IdentityRegistry` and a `compliance` contract.
 *      Facture leaves both at `address(0)` and permissions entirely through the per-security
 *      `ControlList` and `Kyc` facets instead. This is an architectural choice, not a shortcut, and
 *      it is forced by the shape of the product.
 *
 *      The registry interface is `isVerified(address)`. Note what is absent: there is no token
 *      parameter. Verification is a property of an ADDRESS, not of an (address, security) pair. So
 *      every security pointing at one registry shares a single global allowlist.
 *
 *      For a venue issuing one fungible fund token, that is fine and is arguably the point. For
 *      Facture it is fatal, because the venue's founding constraint is that every receivable is its
 *      own instrument. A hundred listed invoices is a hundred separate ATS diamonds. Combine that
 *      with the fact that different invoices carry different offering exemptions - one issued under
 *      Reg D 506(c) to verified accredited investors, another under Reg S to non-US persons - and
 *      the buyer cohorts genuinely differ per instrument. Under a global registry, expressing that
 *      requires one registry DEPLOYMENT per cohort, plus the operational burden of keeping each in
 *      step, plus a permanent risk that an instrument gets pointed at the wrong one. Worse, the
 *      failure is silent: a mis-wired registry does not revert, it just authorises the wrong people.
 *
 *      `ControlList` and `Kyc` live on each security's own diamond. They are already scoped to
 *      exactly one instrument, they are initialised by the same `deployBond` transaction that
 *      creates the security, and they need zero extra deployments. The scoping the product needs is
 *      the scoping ATS already gives, provided you use these facets rather than the registry.
 *
 *      Two consequences are accepted openly:
 *
 *        - Granting a buyer access to N instruments is N grants rather than one. Measured at roughly
 *          190k gas for a KYC grant against 6.98M for the issuance itself, so it is noise against a
 *          cost the venue already pays. Onboarding a buyer to the book is a batched background job,
 *          not something on any critical path.
 *        - There is no single place to read "is this buyer verified". That is the correct model
 *          here. There is no such fact - a buyer is verified FOR AN OFFERING, and the venue should
 *          not be able to express a claim that does not correspond to a real permission.
 *
 *      ------------------------------------------------------------------------------------------
 *      MEMBERSHIP IS NOT PERMISSION
 *      ------------------------------------------------------------------------------------------
 *
 *      The control list takes TWO probes and skipping the second is not an optimisation. ATS
 *      exposes raw membership (`isInControlList`) and the list's mode (`getControlListType`)
 *      separately, and the same `true` means opposite things under each: permitted on an allowlist,
 *      excluded on a blocklist. An earlier version of this contract probed a single `isAuthorized`
 *      that it believed resolved the mode internally. That function does not exist - see
 *      {IAtsFacets} for the correction and how it was proven - and had it existed as imagined,
 *      reading membership alone would still have admitted exactly the party a blocklist was
 *      configured to keep out.
 *
 *      Both probes must succeed. A readable membership beside an unreadable mode is not half an
 *      answer, it is no answer, because the bit cannot be interpreted without the mode.
 *
 *      ------------------------------------------------------------------------------------------
 *      WHY RAW `staticcall` RATHER THAN TYPED INTERFACE CALLS
 *      ------------------------------------------------------------------------------------------
 *
 *      Every probe below is a hand-rolled `staticcall` even though {IAtsFacets} declares the typed
 *      interfaces. Three reasons, in order of importance:
 *
 *        1. FAIL CLOSED, NEVER REVERT. A typed call into a missing facet reverts, and a revert
 *           propagates out of `canReceive`, out of `previewMatch`, and takes down a `view` the UI
 *           depends on. The venue's promise is that a buyer it cannot verify is REFUSED WITH A
 *           REASON, not that the screen breaks. A raw call lets an absent facet, a reverting facet
 *           and a facet returning garbage all collapse into `COMPLIANCE_PROBE_FAILED`.
 *        2. SELECTOR DRIFT IS SURVIVABLE. ATS is a third-party dependency on its own release
 *           cadence. If a signature changes, this gate refuses matches loudly and the test suite
 *           fails, rather than the venue reverting every match with an opaque error.
 *        3. GAS BOUNDING. The probe runs inside matching. A hostile or merely pathological
 *           instrument must not be able to burn the matcher's gas, so each probe is capped.
 *
 *      Note the cost of (1) and (2), which was paid in full: failing closed on an unknown selector
 *      makes a WRONG selector indistinguishable from an unreachable instrument. This contract
 *      shipped probing three functions that do not exist, refusing every buyer on every instrument,
 *      and nothing in its design could report that. Only a call against live paper could, and only
 *      once something called it.
 *
 *      The decode is deliberately `uint256`-then-compare rather than `abi.decode(..., (bool))`,
 *      because ABI-decoding a bool validates that the word is 0 or 1 and REVERTS otherwise - which
 *      would reintroduce exactly the revert path this design exists to avoid. It also lets the KYC
 *      probe read an enum through the same helper rather than through a second decode path.
 *
 *      ------------------------------------------------------------------------------------------
 *      DEPLOYMENT
 *      ------------------------------------------------------------------------------------------
 *
 *      Must be deployed on the same chain as the instruments (Hedera). It is stateless, immutable
 *      and holds no funds, so one instance serves every instrument the venue lists.
 */
contract AtsComplianceGate is IComplianceGate {
    /**
     * @notice Gas forwarded to each facet probe.
     *
     * @dev Measured, not guessed. Against MF-2051 on Hedera testnet the four probes estimate at
     *      51,820 / 49,519 / 50,261 / 64,516 gas INCLUDING the 21,000 intrinsic transaction cost
     *      that a `staticcall` from inside a contract does not pay - so the execution this cap has
     *      to cover is roughly 28k-44k, through the diamond's own dispatch. 150,000 is about 3.4x
     *      the dearest observed.
     *
     *      The honest trade-off: a legitimate facet that is unusually expensive would be reported as
     *      `COMPLIANCE_PROBE_FAILED`, i.e. a false refusal. That direction is chosen deliberately -
     *      a false refusal is visible, named and recoverable by the buyer asking why, whereas the
     *      opposite failure mode is an illegal trade.
     *
     *      Hedera note: gas here bounds EVM execution as usual, but Hedera bills the transaction
     *      close to its declared limit rather than to consumption, so the saving from a tight cap is
     *      about protecting the matcher from griefing, not about reducing the fee.
     */
    uint256 public constant PROBE_GAS = 150_000;

    /**
     * @notice `IKyc.KycStatus.GRANTED`.
     * @dev Compared exactly, never `!= 0`. The facet returns an enum, and a loose comparison would
     *      read any status ATS adds after this was written - a revoked or suspended grant among
     *      them - as a valid one.
     */
    uint256 private constant KYC_GRANTED = 1;

    /// @inheritdoc IComplianceGate
    function canReceive(address instrument, address buyer) external view returns (bool ok, bytes32 reasonCode) {
        // A zero address on either side is a caller bug, but this function must not revert, so it is
        // reported through the same channel as everything else.
        if (instrument == address(0) || buyer == address(0)) {
            return (false, ReasonCodes.COMPLIANCE_PROBE_FAILED);
        }

        // Probe order is cheapest-and-most-global first, so the commonest hard stops short-circuit.
        //
        // 1. Paused. A paused instrument would refuse delivery to ANY buyer, so establishing this
        //    first avoids telling a perfectly eligible buyer that they are the problem.
        (bool probed, uint256 word) = _probeWord(instrument, abi.encodeCall(IAtsPause.paused, ()));
        if (!probed) return (false, ReasonCodes.COMPLIANCE_PROBE_FAILED);
        if (word != 0) return (false, ReasonCodes.INSTRUMENT_PAUSED);

        // 2. Control list, in two parts. Mode first: without it the membership bit below cannot be
        //    interpreted at all, so there is nothing to be gained by asking in the other order.
        (bool modeProbed, uint256 isAllowList) =
            _probeWord(instrument, abi.encodeCall(IAtsControlList.getControlListType, ()));
        if (!modeProbed) return (false, ReasonCodes.COMPLIANCE_PROBE_FAILED);

        (bool memberProbed, uint256 isMember) =
            _probeWord(instrument, abi.encodeCall(IAtsControlList.isInControlList, (buyer)));
        if (!memberProbed) return (false, ReasonCodes.COMPLIANCE_PROBE_FAILED);

        // An allowlist permits its members; a blocklist permits everyone else. Same bit, opposite
        // meanings - see the header.
        ok = isAllowList != 0 ? isMember != 0 : isMember == 0;
        if (!ok) return (false, ReasonCodes.CONTROL_LIST_BLOCKED);

        // 3. KYC. Last because it is the most specific refusal, and the one most likely to be
        //    actionable: an unlisted buyer can go and get a grant for this instrument.
        (probed, word) = _probeWord(instrument, abi.encodeCall(IAtsKyc.getKycStatusFor, (buyer)));
        if (!probed) return (false, ReasonCodes.COMPLIANCE_PROBE_FAILED);
        if (word != KYC_GRANTED) return (false, ReasonCodes.NOT_KYC_VERIFIED);

        return (true, ReasonCodes.NONE);
    }

    /**
     * @notice Read one word from a facet without ever reverting.
     * @dev Returns `probed == false` for: a call that reverted, a call that ran out of the probe's
     *      gas, an address with no code (which returns success and empty data), and any return
     *      shorter than one word. Every one of those means the venue could not establish the fact it
     *      needs, which is a refusal.
     *
     *      The caller decides what the word means. A bool facet is `!= 0`; the KYC facet returns an
     *      enum and is compared exactly. Decoding here would force one interpretation on both.
     * @param target The security diamond.
     * @param callData Encoded facet call.
     * @return probed True only if a full word came back.
     * @return value The raw word, meaningful only when `probed`.
     */
    function _probeWord(address target, bytes memory callData) private view returns (bool probed, uint256 value) {
        // An EOA or a self-destructed contract returns success with empty returndata, which the
        // length check below catches. Checking `code.length` first would cost an extra EXTCODESIZE
        // per probe for no additional safety.
        (bool success, bytes memory returnData) = target.staticcall{gas: PROBE_GAS}(callData);

        if (!success || returnData.length < 32) return (false, 0);

        // Read as a word rather than `abi.decode`, which reverts on anything a bool or a narrow
        // enum cannot represent. See the contract header.
        uint256 word;
        assembly ("memory-safe") {
            word := mload(add(returnData, 0x20))
        }

        return (true, word);
    }
}
