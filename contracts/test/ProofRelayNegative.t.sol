// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ProofRelay} from "../src/ProofRelay.sol";
import {ProofRelayFixture} from "./Base.t.sol";

/**
 * Everything that must be refused. The threat model's claims are only worth
 * something if the refusals are real, so each case asserts the specific error
 * rather than just "it reverted".
 */
contract ProofRelayNegativeTest is ProofRelayFixture {
    function _longPointer() internal pure returns (string memory) {
        bytes memory buf = new bytes(257);
        for (uint256 i; i < 257; ++i) {
            buf[i] = "x";
        }
        return string(buf);
    }

    function _windowSpec(uint32 commitWindow, uint32 revealWindow, uint32 disputeWindow)
        internal
        pure
        returns (ProofRelay.TaskSpec memory spec)
    {
        spec = ProofRelay.TaskSpec({
            verifierCount: 2,
            commitWindowSec: commitWindow,
            revealWindowSec: revealWindow,
            disputeWindowSec: disputeWindow,
            manifestHash: keccak256("manifest"),
            manifestPointer: "0g://manifest",
            ruleId: keccak256("rule")
        });
    }

    /* ── commit ───────────────────────────────────────────────────────────── */

    function test_RevertWhen_CommitOnUnknownTask() public {
        vm.prank(verifierA);
        vm.expectRevert(ProofRelay.TaskNotFound.selector);
        relay.commitReport(keccak256("nope"), keccak256("c"));
    }

    function test_RevertWhen_CommitterIsNotRegistered() public {
        bytes32 taskId = _createTask();
        vm.prank(verifierC);
        vm.expectRevert(ProofRelay.VerifierNotActive.selector);
        relay.commitReport(taskId, keccak256("c"));
    }

    function test_RevertWhen_CommitterIsNotApproved() public {
        bytes32 taskId = _createTask();
        vm.prank(verifierC);
        relay.registerVerifier(keccak256("meta"), "0g://meta");

        vm.prank(verifierC);
        vm.expectRevert(ProofRelay.VerifierNotActive.selector);
        relay.commitReport(taskId, keccak256("c"));
    }

    function test_RevertWhen_CommitterIsInactive() public {
        bytes32 taskId = _createTask();
        vm.prank(verifierA);
        relay.setVerifierActive(false);

        vm.prank(verifierA);
        vm.expectRevert(ProofRelay.VerifierNotActive.selector);
        relay.commitReport(taskId, keccak256("c"));
    }

    function test_RevertWhen_CommittingTwice() public {
        bytes32 taskId = _createTask();
        _commit(taskId, verifierA);

        vm.prank(verifierA);
        vm.expectRevert(ProofRelay.AlreadyCommitted.selector);
        relay.commitReport(taskId, keccak256("other"));
    }

    function test_RevertWhen_CommitWindowHasClosed() public {
        bytes32 taskId = _createTask();
        vm.warp(uint256(relay.getTask(taskId).commitDeadline) + 1);

        vm.prank(verifierA);
        vm.expectRevert(ProofRelay.CommitClosed.selector);
        relay.commitReport(taskId, keccak256("c"));
    }

    function test_RevertWhen_MoreCommitsThanTheTaskAskedFor() public {
        _enroll(verifierC);
        bytes32 taskId = _createTask();
        _commit(taskId, verifierA);
        _commit(taskId, verifierB);

        vm.prank(verifierC);
        vm.expectRevert(ProofRelay.TooManyCommitments.selector);
        relay.commitReport(taskId, keccak256("c"));
    }

    function test_RevertWhen_CommitmentIsZero() public {
        bytes32 taskId = _createTask();
        vm.prank(verifierA);
        vm.expectRevert(ProofRelay.CommitmentMismatch.selector);
        relay.commitReport(taskId, bytes32(0));
    }

    function test_RevertWhen_CommittingAfterConsensus() public {
        bytes32 taskId = _consensusTask();
        vm.prank(verifierA);
        vm.expectRevert(ProofRelay.InvalidStatus.selector);
        relay.commitReport(taskId, keccak256("c"));
    }

    /* ── reveal ───────────────────────────────────────────────────────────── */

    function test_RevertWhen_RevealSaltIsWrong() public {
        bytes32 taskId = _createTask();
        _commit(taskId, verifierA);
        _commit(taskId, verifierB);

        vm.prank(verifierA);
        vm.expectRevert(ProofRelay.CommitmentMismatch.selector);
        relay.revealReport(taskId, _reportHash(verifierA), "0g://report", keccak256("wrong"));
    }

    function test_RevertWhen_RevealReportHashIsWrong() public {
        bytes32 taskId = _createTask();
        _commit(taskId, verifierA);
        _commit(taskId, verifierB);

        vm.prank(verifierA);
        vm.expectRevert(ProofRelay.CommitmentMismatch.selector);
        relay.revealReport(taskId, keccak256("different"), "0g://report", _salt(verifierA));
    }

    /**
     * The anti-copying property: another verifier's commitment can be replayed
     * onchain, but it is bound to the address that made it, so the copy can
     * never be opened.
     */
    function test_RevertWhen_ReplayingAnotherVerifiersCommitment() public {
        bytes32 taskId = _createTask();
        bytes32 stolen = relay.computeCommitment(taskId, verifierA, _reportHash(verifierA), _salt(verifierA));

        vm.prank(verifierA);
        relay.commitReport(taskId, stolen);
        vm.prank(verifierB);
        relay.commitReport(taskId, stolen);

        vm.prank(verifierB);
        vm.expectRevert(ProofRelay.CommitmentMismatch.selector);
        relay.revealReport(taskId, _reportHash(verifierA), "0g://report", _salt(verifierA));
    }

    function test_RevertWhen_RevealingWhileACommitSlotIsStillOpen() public {
        bytes32 taskId = _createTask();
        _commit(taskId, verifierA);

        vm.prank(verifierA);
        vm.expectRevert(ProofRelay.RevealNotOpen.selector);
        relay.revealReport(taskId, _reportHash(verifierA), "0g://report", _salt(verifierA));
    }

    function test_RevertWhen_RevealingAfterTheRevealDeadline() public {
        bytes32 taskId = _createTask();
        _commit(taskId, verifierA);
        _commit(taskId, verifierB);
        _skipPastReveal(taskId);

        vm.prank(verifierA);
        vm.expectRevert(ProofRelay.DeadlinePassed.selector);
        relay.revealReport(taskId, _reportHash(verifierA), "0g://report", _salt(verifierA));
    }

    function test_RevertWhen_RevealingTwice() public {
        bytes32 taskId = _revealedTask();
        vm.prank(verifierA);
        vm.expectRevert(ProofRelay.AlreadyRevealed.selector);
        relay.revealReport(taskId, _reportHash(verifierA), "0g://report", _salt(verifierA));
    }

    function test_RevertWhen_RevealingWithoutACommitment() public {
        _enroll(verifierC);
        bytes32 taskId = _revealedTask();

        vm.prank(verifierC);
        vm.expectRevert(ProofRelay.NotRevealer.selector);
        relay.revealReport(taskId, _reportHash(verifierC), "0g://report", _salt(verifierC));
    }

    function test_RevertWhen_RevealingBeforeAnyoneCommitted() public {
        bytes32 taskId = _createTask();
        vm.prank(verifierA);
        vm.expectRevert(ProofRelay.InvalidStatus.selector);
        relay.revealReport(taskId, _reportHash(verifierA), "0g://report", _salt(verifierA));
    }

    function test_RevertWhen_RevealPointerIsTooLong() public {
        bytes32 taskId = _createTask();
        _commit(taskId, verifierA);
        _commit(taskId, verifierB);

        vm.prank(verifierA);
        vm.expectRevert(ProofRelay.PointerTooLong.selector);
        relay.revealReport(taskId, _reportHash(verifierA), _longPointer(), _salt(verifierA));
    }

    /* ── finalizeConsensus ────────────────────────────────────────────────── */

    function test_RevertWhen_NonKeeperFinalizes() public {
        bytes32 taskId = _revealedTask();
        vm.prank(stranger);
        vm.expectRevert(ProofRelay.NotAuthorized.selector);
        relay.finalizeConsensus(taskId, keccak256("r"), 1, _both(), 10_000);
    }

    function test_RevertWhen_AdminFinalizes() public {
        bytes32 taskId = _revealedTask();
        vm.prank(admin);
        vm.expectRevert(ProofRelay.NotAuthorized.selector);
        relay.finalizeConsensus(taskId, keccak256("r"), 1, _both(), 10_000);
    }

    function test_RevertWhen_FinalizingConsensusOnAnUnknownTask() public {
        vm.prank(keeper);
        vm.expectRevert(ProofRelay.TaskNotFound.selector);
        relay.finalizeConsensus(keccak256("nope"), keccak256("r"), 1, _both(), 10_000);
    }

    function test_RevertWhen_OutcomeIsNone() public {
        bytes32 taskId = _revealedTask();
        vm.prank(keeper);
        vm.expectRevert(ProofRelay.InvalidOutcome.selector);
        relay.finalizeConsensus(taskId, keccak256("r"), 0, _none(), 0);
    }

    function test_RevertWhen_OutcomeIsOutOfRange() public {
        bytes32 taskId = _revealedTask();
        vm.prank(keeper);
        vm.expectRevert(ProofRelay.InvalidOutcome.selector);
        relay.finalizeConsensus(taskId, keccak256("r"), 4, _none(), 0);
    }

    function test_RevertWhen_RewardingAVerifierThatNeverRevealed() public {
        _enroll(verifierC);
        bytes32 taskId = _revealedTask();

        vm.prank(keeper);
        vm.expectRevert(ProofRelay.NotRevealer.selector);
        relay.finalizeConsensus(taskId, keccak256("r"), 1, _one(verifierC), 10_000);
    }

    function test_RevertWhen_KeeperPaysItself() public {
        bytes32 taskId = _revealedTask();
        vm.prank(keeper);
        vm.expectRevert(ProofRelay.InvalidBeneficiary.selector);
        relay.finalizeConsensus(taskId, keccak256("r"), 1, _one(keeper), 10_000);
    }

    /**
     * The keeper key is only "partially trusted" because it names a
     * classification and never an amount. That holds only if it cannot name
     * itself — and being a revealed verifier is two admin transactions away, so
     * the refusal has to come from the self-payment check rather than from the
     * keeper coincidentally not being a verifier.
     */
    function test_RevertWhen_KeeperIsAlsoARevealedVerifierAndNamesItself() public {
        _enroll(keeper);
        vm.deal(keeper, 1 ether);

        bytes32 taskId = _createTask();
        _commit(taskId, keeper);
        _commit(taskId, verifierA);
        _reveal(taskId, keeper);
        _reveal(taskId, verifierA);
        assertTrue(relay.getReport(taskId, keeper).revealed, "keeper really did reveal");

        vm.prank(keeper);
        vm.expectRevert(ProofRelay.InvalidBeneficiary.selector);
        relay.finalizeConsensus(taskId, keccak256("r"), 1, _one(keeper), 10_000);

        // Naming someone else still works, and the keeper is left with nothing.
        vm.prank(keeper);
        relay.finalizeConsensus(taskId, keccak256("r"), 1, _one(verifierA), 10_000);
        assertEq(relay.allocationOf(taskId, keeper), 0, "keeper allocated nothing");
    }

    /// The same escalation starting from the admin key, which can mint the rest of itself.
    function test_RevertWhen_AdminGrantsItselfKeeperAndSelfDeals() public {
        vm.startPrank(admin);
        relay.grantRole(relay.KEEPER_ROLE(), admin);
        relay.setVerifierApproval(admin, true);
        vm.stopPrank();
        vm.prank(admin);
        relay.registerVerifier(keccak256("admin"), "0g://admin");

        bytes32 taskId = _createTask();
        _commit(taskId, admin);
        _commit(taskId, verifierA);
        _reveal(taskId, admin);
        _reveal(taskId, verifierA);

        vm.prank(admin);
        vm.expectRevert(ProofRelay.InvalidBeneficiary.selector);
        relay.finalizeConsensus(taskId, keccak256("r"), 1, _one(admin), 10_000);
    }

    function test_RevertWhen_BeneficiaryIsRepeated() public {
        bytes32 taskId = _revealedTask();
        address[] memory set = new address[](2);
        set[0] = verifierA;
        set[1] = verifierA;

        vm.prank(keeper);
        vm.expectRevert(ProofRelay.DuplicateBeneficiary.selector);
        relay.finalizeConsensus(taskId, keccak256("r"), 1, set, 10_000);
    }

    function test_RevertWhen_MoreBeneficiariesThanVerifiers() public {
        _enroll(verifierC);
        bytes32 taskId = _revealedTask();
        address[] memory set = new address[](3);
        set[0] = verifierA;
        set[1] = verifierB;
        set[2] = verifierC;

        vm.prank(keeper);
        vm.expectRevert(ProofRelay.InvalidBeneficiary.selector);
        relay.finalizeConsensus(taskId, keccak256("r"), 1, set, 10_000);
    }

    function test_RevertWhen_ConsensusHasNoBeneficiaries() public {
        bytes32 taskId = _revealedTask();
        vm.prank(keeper);
        vm.expectRevert(ProofRelay.InvalidBeneficiary.selector);
        relay.finalizeConsensus(taskId, keccak256("r"), 1, _none(), 10_000);
    }

    function test_RevertWhen_ConflictNamesBeneficiaries() public {
        bytes32 taskId = _revealedTask();
        vm.prank(keeper);
        vm.expectRevert(ProofRelay.InvalidBeneficiary.selector);
        relay.finalizeConsensus(taskId, keccak256("r"), 2, _both(), 0);
    }

    function test_RevertWhen_NoQuorumNamesBeneficiaries() public {
        bytes32 taskId = _revealedTask();
        vm.prank(keeper);
        vm.expectRevert(ProofRelay.InvalidBeneficiary.selector);
        relay.finalizeConsensus(taskId, keccak256("r"), 3, _both(), 0);
    }

    function test_RevertWhen_RewardBpsExceedsTheDenominator() public {
        bytes32 taskId = _revealedTask();
        vm.prank(keeper);
        vm.expectRevert(ProofRelay.InvalidRewardBps.selector);
        relay.finalizeConsensus(taskId, keccak256("r"), 1, _both(), 10_001);
    }

    function test_RevertWhen_FinalizingBeforeTheRevealRoundIsDone() public {
        bytes32 taskId = _createTask();
        _commit(taskId, verifierA);
        _commit(taskId, verifierB);
        _reveal(taskId, verifierA);

        vm.prank(keeper);
        vm.expectRevert(ProofRelay.RevealNotClosed.selector);
        relay.finalizeConsensus(taskId, keccak256("r"), 1, _one(verifierA), 10_000);
    }

    function test_RevertWhen_FinalizingConsensusTwice() public {
        bytes32 taskId = _consensusTask();
        vm.prank(keeper);
        vm.expectRevert(ProofRelay.InvalidStatus.selector);
        relay.finalizeConsensus(taskId, keccak256("r"), 1, _both(), 10_000);
    }

    /* ── claims and withdrawals ───────────────────────────────────────────── */

    function test_RevertWhen_ClaimingDuringTheDisputeWindow() public {
        bytes32 taskId = _consensusTask();
        vm.prank(verifierA);
        vm.expectRevert(ProofRelay.InvalidStatus.selector);
        relay.claimReward(taskId);
    }

    function test_RevertWhen_ClaimingTwice() public {
        bytes32 taskId = _consensusTask();
        _skipPastDispute(taskId);

        vm.prank(verifierA);
        relay.claimReward(taskId);

        vm.prank(verifierA);
        vm.expectRevert(ProofRelay.NothingToClaim.selector);
        relay.claimReward(taskId);
    }

    function test_RevertWhen_ClaimingWithNoAllocation() public {
        bytes32 taskId = _consensusTask();
        _skipPastDispute(taskId);

        vm.prank(stranger);
        vm.expectRevert(ProofRelay.NothingToClaim.selector);
        relay.claimReward(taskId);
    }

    function test_RevertWhen_ClaimingOnAnUnknownTask() public {
        vm.prank(verifierA);
        vm.expectRevert(ProofRelay.TaskNotFound.selector);
        relay.claimReward(keccak256("nope"));
    }

    function test_RevertWhen_NonCreatorAsksForARefund() public {
        bytes32 taskId = _createTask();
        vm.prank(stranger);
        vm.expectRevert(ProofRelay.NotAuthorized.selector);
        relay.refundCreator(taskId);
    }

    function test_RevertWhen_WithdrawingNothing() public {
        vm.prank(stranger);
        vm.expectRevert(ProofRelay.NothingToWithdraw.selector);
        relay.withdraw();
    }

    /* ── challenges ───────────────────────────────────────────────────────── */

    function test_RevertWhen_BondIsTooSmall() public {
        bytes32 taskId = _consensusTask();
        uint256 bond = _bond(BOUNTY);

        vm.prank(creator);
        vm.expectRevert(ProofRelay.InsufficientBond.selector);
        relay.openChallenge{value: bond - 1}(taskId, keccak256("e"), "0g://e");
    }

    function test_RevertWhen_BondIsTooLarge() public {
        bytes32 taskId = _consensusTask();
        uint256 bond = _bond(BOUNTY);

        vm.prank(creator);
        vm.expectRevert(ProofRelay.InsufficientBond.selector);
        relay.openChallenge{value: bond + 1}(taskId, keccak256("e"), "0g://e");
    }

    function test_RevertWhen_ChallengerIsNotAPartyToTheTask() public {
        bytes32 taskId = _consensusTask();
        uint256 bond = _bond(BOUNTY);

        vm.prank(stranger);
        vm.expectRevert(ProofRelay.NotAuthorized.selector);
        relay.openChallenge{value: bond}(taskId, keccak256("e"), "0g://e");
    }

    function test_RevertWhen_ChallengingTwice() public {
        bytes32 taskId = _disputedTask();
        uint256 bond = _bond(BOUNTY);

        vm.prank(verifierA);
        vm.expectRevert(ProofRelay.InvalidStatus.selector);
        relay.openChallenge{value: bond}(taskId, keccak256("e"), "0g://e");
    }

    function test_RevertWhen_ChallengingAfterTheDisputeWindow() public {
        bytes32 taskId = _consensusTask();
        uint256 bond = _bond(BOUNTY);
        _skipPastDispute(taskId);

        vm.prank(creator);
        vm.expectRevert(ProofRelay.DeadlinePassed.selector);
        relay.openChallenge{value: bond}(taskId, keccak256("e"), "0g://e");
    }

    function test_RevertWhen_ChallengingBeforeConsensus() public {
        bytes32 taskId = _createTask();
        uint256 bond = _bond(BOUNTY);

        vm.prank(creator);
        vm.expectRevert(ProofRelay.InvalidStatus.selector);
        relay.openChallenge{value: bond}(taskId, keccak256("e"), "0g://e");
    }

    function test_RevertWhen_ChallengeEvidencePointerIsTooLong() public {
        bytes32 taskId = _consensusTask();
        uint256 bond = _bond(BOUNTY);

        vm.prank(creator);
        vm.expectRevert(ProofRelay.PointerTooLong.selector);
        relay.openChallenge{value: bond}(taskId, keccak256("e"), _longPointer());
    }

    /* ── adjudication ─────────────────────────────────────────────────────── */

    function test_RevertWhen_NonAdjudicatorResolves() public {
        bytes32 taskId = _disputedTask();
        vm.prank(keeper);
        vm.expectRevert(ProofRelay.NotAuthorized.selector);
        relay.resolveDispute(taskId, true, keccak256("a"), "0g://a", _none(), keccak256("why"));
    }

    function test_RevertWhen_ResolvingATaskWithNoDispute() public {
        bytes32 taskId = _consensusTask();
        vm.prank(adjudicator);
        vm.expectRevert(ProofRelay.DisputeNotFound.selector);
        relay.resolveDispute(taskId, true, keccak256("a"), "0g://a", _none(), keccak256("why"));
    }

    function test_RevertWhen_ResolvingTwice() public {
        bytes32 taskId = _disputedTask();
        vm.prank(adjudicator);
        relay.resolveDispute(taskId, true, keccak256("a"), "0g://a", _none(), keccak256("why"));

        vm.prank(adjudicator);
        vm.expectRevert(ProofRelay.DisputeAlreadyResolved.selector);
        relay.resolveDispute(taskId, false, keccak256("a"), "0g://a", _none(), keccak256("why"));
    }

    function test_RevertWhen_AdjudicatorPaysANonRevealer() public {
        _enroll(verifierC);
        bytes32 taskId = _disputedTask();

        vm.prank(adjudicator);
        vm.expectRevert(ProofRelay.NotRevealer.selector);
        relay.resolveDispute(taskId, true, keccak256("a"), "0g://a", _one(verifierC), keccak256("why"));
    }

    function test_RevertWhen_AdjudicatorPaysItself() public {
        bytes32 taskId = _disputedTask();
        vm.prank(adjudicator);
        vm.expectRevert(ProofRelay.InvalidBeneficiary.selector);
        relay.resolveDispute(taskId, true, keccak256("a"), "0g://a", _one(adjudicator), keccak256("why"));
    }

    /// As above: the refusal must survive the adjudicator also being a revealer.
    function test_RevertWhen_AdjudicatorIsAlsoARevealedVerifierAndNamesItself() public {
        _enroll(adjudicator);
        vm.deal(adjudicator, 1 ether);

        bytes32 taskId = _createTask();
        _commit(taskId, adjudicator);
        _commit(taskId, verifierA);
        _reveal(taskId, adjudicator);
        _reveal(taskId, verifierA);

        vm.prank(keeper);
        relay.finalizeConsensus(taskId, keccak256("r"), 1, _one(verifierA), 10_000);
        uint256 bond = _bond(BOUNTY);
        vm.prank(creator);
        relay.openChallenge{value: bond}(taskId, keccak256("e"), "0g://e");

        vm.prank(adjudicator);
        vm.expectRevert(ProofRelay.InvalidBeneficiary.selector);
        relay.resolveDispute(taskId, true, keccak256("a"), "0g://a", _one(adjudicator), keccak256("why"));
    }

    function test_RevertWhen_AdjudicationPointerIsTooLong() public {
        bytes32 taskId = _disputedTask();
        vm.prank(adjudicator);
        vm.expectRevert(ProofRelay.PointerTooLong.selector);
        relay.resolveDispute(taskId, true, keccak256("a"), _longPointer(), _none(), keccak256("why"));
    }

    function test_RevertWhen_ExpiringADisputeEarly() public {
        bytes32 taskId = _disputedTask();
        vm.expectRevert(ProofRelay.WindowNotElapsed.selector);
        relay.expireDispute(taskId);
    }

    /**
     * `openChallenge` already limits challengers to the creator and the task's
     * committed verifiers, so a bare adjudicator key cannot be one. The reachable
     * shape is one key holding two roles — which is exactly the live deployment,
     * where admin, keeper and adjudicator are a single address. `_settleUpheld`
     * pays the challenger directly and never routes it through
     * `_requireRevealedSet`, so that key could uphold its own challenge and take
     * the bond back plus `challengerRewardBps` of the bounty.
     */
    function test_RevertWhen_TheAdjudicatorUpholdsItsOwnChallenge() public {
        bytes32 taskId = _consensusTask();
        uint256 bond = _bond(BOUNTY);

        // Read the role before the prank: an external call inside the argument
        // list consumes it, and grantRole would arrive from this test contract.
        bytes32 adjudicatorRole = relay.ADJUDICATOR_ROLE();
        vm.prank(admin);
        relay.grantRole(adjudicatorRole, creator);

        vm.prank(creator);
        relay.openChallenge{value: bond}(taskId, keccak256("evidence"), "0g://evidence");

        vm.prank(creator);
        vm.expectRevert(ProofRelay.NotAuthorized.selector);
        relay.resolveDispute(taskId, true, keccak256("adj"), "0g://adj", _one(verifierB), keccak256("why"));

        // Rejecting its own challenge is refused on the same ground: the role
        // arbitrates a dispute, it is never a party to one.
        vm.prank(creator);
        vm.expectRevert(ProofRelay.NotAuthorized.selector);
        relay.resolveDispute(taskId, false, keccak256("adj"), "0g://adj", _none(), keccak256("why"));

        // An adjudicator that is not a party still resolves it normally.
        vm.prank(adjudicator);
        relay.resolveDispute(taskId, true, keccak256("adj"), "0g://adj", _one(verifierB), keccak256("why"));
        assertEq(
            uint256(uint8(relay.getTask(taskId).status)),
            uint256(uint8(ProofRelay.TaskStatus.Finalized)),
            "an impartial adjudicator still settles it"
        );
    }

    /**
     * DEFAULT_ADMIN_ROLE can only be granted by a holder of it, so an admin
     * revoking itself on a single-key deployment — which is what Deploy.s.sol
     * produces by default — leaves the contract permanently unadministrable.
     * Rotation still works in the runbook's order: grant, then revoke.
     */
    function test_RevertWhen_TheLastAdminRevokesItself() public {
        bytes32 adminRole = relay.DEFAULT_ADMIN_ROLE();

        vm.prank(admin);
        vm.expectRevert(ProofRelay.NotAuthorized.selector);
        relay.revokeRole(adminRole, admin);

        assertTrue(relay.hasRole(adminRole, admin), "admin kept its role");

        // Grant a successor, and the successor may retire the old key.
        address successor = address(0xA11CE2);
        vm.prank(admin);
        relay.grantRole(adminRole, successor);
        vm.prank(successor);
        relay.revokeRole(adminRole, admin);

        assertFalse(relay.hasRole(adminRole, admin), "old key retired");
        assertTrue(relay.hasRole(adminRole, successor), "successor holds it");
    }

    /**
     * `revealed` is a boolean the verifier sets by revealing, and the conflict
     * rate paid on it alone — so a verifier that fetched nothing, ran nothing
     * and uploaded nothing could commit to an empty report, reveal it, and be
     * paid exactly what a verifier that did the work is paid.
     */
    function test_RevertWhen_RevealingAReportThatNamesNothing() public {
        bytes32 taskId = _createTask();
        bytes32 empty = relay.computeCommitment(taskId, verifierA, bytes32(0), bytes32(0));
        vm.prank(verifierA);
        relay.commitReport(taskId, empty);
        _commit(taskId, verifierB);

        vm.prank(verifierA);
        vm.expectRevert(ProofRelay.EmptyArtifact.selector);
        relay.revealReport(taskId, bytes32(0), "", bytes32(0));
    }

    /// A challenge freezes the whole task, so it must point at something readable.
    function test_RevertWhen_ChallengingWithNoEvidence() public {
        bytes32 taskId = _consensusTask();
        uint256 bond = _bond(BOUNTY);

        vm.prank(creator);
        vm.expectRevert(ProofRelay.EmptyArtifact.selector);
        relay.openChallenge{value: bond}(taskId, bytes32(0), "0g://e");

        vm.prank(creator);
        vm.expectRevert(ProofRelay.EmptyArtifact.selector);
        relay.openChallenge{value: bond}(taskId, keccak256("e"), "");
    }

    /**
     * The forfeited bond compensates the verifiers the challenge defamed. A
     * challenger that also revealed on the task is not one of them, and paying it
     * a share refunds part of the forfeit it just lost.
     */
    function test_ResolveDispute_RejectedPaysTheChallengerNoneOfItsOwnBond() public {
        bytes32 taskId = _consensusTask();
        uint256 bond = _bond(BOUNTY);
        vm.deal(verifierA, bond);
        vm.warp(uint256(relay.getTask(taskId).consensusAt) + DISPUTE_WINDOW / 2 + 1);
        vm.prank(verifierA);
        relay.openChallenge{value: bond}(taskId, keccak256("e"), "0g://e");

        uint256 challengerBefore = relay.allocationOf(taskId, verifierA);

        vm.prank(adjudicator);
        vm.expectRevert(ProofRelay.InvalidBeneficiary.selector);
        relay.resolveDispute(taskId, false, keccak256("a"), "0g://a", _both(), keccak256("why"));

        // With no explicit set the defended split skips the challenger by itself.
        vm.prank(adjudicator);
        relay.resolveDispute(taskId, false, keccak256("a"), "0g://a", _none(), keccak256("why"));

        assertEq(relay.allocationOf(taskId, verifierA), challengerBefore, "challenger kept none of its forfeit");
        assertTrue(
            relay.allocationOf(taskId, verifierB) > BOUNTY / 2,
            "the defended verifier was compensated"
        );
    }

    /// `createTask` bounds its uint32 deadline casts; `openChallenge` did not.
    function test_RevertWhen_TheAdjudicationDeadlineWouldOverflowUint32() public {
        // Late enough that a 7-day adjudication window overflows uint32, but
        // early enough that the task's own 900-second windows still fit.
        vm.warp(uint256(type(uint32).max) - 66_000);

        bytes32 taskId = _consensusTask();
        uint256 bond = _bond(BOUNTY);

        vm.prank(creator);
        vm.expectRevert(ProofRelay.InvalidWindow.selector);
        relay.openChallenge{value: bond}(taskId, keccak256("e"), "0g://e");
    }

    /**
     * The roles are not one key by necessity, so checking only `msg.sender` let a
     * keeper name the adjudicator — or an admin name either of them — and route
     * the bounty to a key it also controls. No role holder may be a chosen
     * beneficiary. (A fresh EOA holding no role is still reachable by an admin
     * through `setVerifierApproval`; separating the keys is what bounds that.)
     */
    function test_RevertWhen_TheKeeperNamesAnotherRoleHolderAsBeneficiary() public {
        bytes32 taskId = _revealedTask();
        bytes32 keeperRole = relay.KEEPER_ROLE();

        vm.prank(admin);
        relay.grantRole(keeperRole, verifierA);

        vm.prank(keeper);
        vm.expectRevert(ProofRelay.InvalidBeneficiary.selector);
        relay.finalizeConsensus(taskId, keccak256("r"), 1, _both(), 10_000);
    }

    /**
     * A task has exactly one dispute slot, first-come-first-served, which made
     * the remedy monopolisable by the party it exists to check: a verifier that
     * knows its own report was fabricated opens a bogus challenge the instant
     * consensus lands, burns the slot, and lets it expire — the creator never
     * gets to challenge at all, and the fraudulent reward stands.
     */
    function test_OpenChallenge_AVerifierCannotBurnTheCreatorsSlot() public {
        bytes32 taskId = _consensusTask();
        uint256 bond = _bond(BOUNTY);
        vm.deal(verifierA, bond);
        uint256 consensusAt = uint256(relay.getTask(taskId).consensusAt);

        vm.prank(verifierA);
        vm.expectRevert(ProofRelay.WindowNotElapsed.selector);
        relay.openChallenge{value: bond}(taskId, keccak256("bogus"), "0g://bogus");

        // Still refused on the last second of the creator's half.
        vm.warp(consensusAt + DISPUTE_WINDOW / 2);
        vm.prank(verifierA);
        vm.expectRevert(ProofRelay.WindowNotElapsed.selector);
        relay.openChallenge{value: bond}(taskId, keccak256("bogus"), "0g://bogus");

        vm.prank(creator);
        relay.openChallenge{value: bond}(taskId, keccak256("evidence"), "0g://evidence");
        assertEq(relay.getDispute(taskId).challenger, creator, "the creator kept its remedy");
    }

    /**
     * And it stays symmetric: where the harmed party is the verifiers rather
     * than the creator — a keeper that misclassified a genuine consensus — the
     * creator has no reason to challenge, so the slot reaches the verifiers with
     * half the window still to run.
     */
    function test_OpenChallenge_ReachesTheVerifiersOnceTheCreatorsHalfPasses() public {
        bytes32 taskId = _consensusTask();
        uint256 bond = _bond(BOUNTY);
        vm.deal(verifierB, bond);
        vm.warp(uint256(relay.getTask(taskId).consensusAt) + DISPUTE_WINDOW / 2 + 1);

        vm.prank(verifierB);
        relay.openChallenge{value: bond}(taskId, keccak256("evidence"), "0g://evidence");

        assertEq(relay.getDispute(taskId).challenger, verifierB, "the verifier still has its remedy");
        assertTrue(
            block.timestamp < uint256(relay.getTask(taskId).consensusAt) + DISPUTE_WINDOW,
            "with window left to adjudicate in"
        );
    }

    /// `pause()` has an access-control test; its sibling never did.
    function test_RevertWhen_AStrangerUnpauses() public {
        vm.prank(admin);
        relay.pause();

        vm.prank(stranger);
        vm.expectRevert(ProofRelay.NotAuthorized.selector);
        relay.unpause();

        assertTrue(relay.paused(), "still paused");

        vm.prank(admin);
        relay.unpause();
        assertFalse(relay.paused(), "the pauser can lift it");
    }

    /**
     * A beneficiary that calls back in gets nothing extra and cannot touch
     * anyone else's escrow.
     *
     * Worth being precise about what protects this, because the audit finding
     * that prompted the test said `nonReentrant` had no coverage — and it still
     * does not, in the sense that deleting the modifier leaves this test green.
     * That is not a weak test: `withdraw()` zeroes `pendingWithdrawals` BEFORE
     * the external call, so the re-entry finds nothing to pay and reverts with
     * NothingToWithdraw on its own. Checks-effects-interactions is the load-
     * bearing protection here and `nonReentrant` is the second layer. What this
     * pins is the property that actually matters — no extra wei leaves — rather
     * than the presence of a modifier.
     */
    function test_Withdraw_RefusesAReentrantBeneficiary() public {
        // Someone else's escrow, so a successful re-entry would have something
        // to steal.
        bytes32 other = _createTask();

        ReentrantBeneficiary attacker = new ReentrantBeneficiary(relay);
        // The value comes from this contract, so the attacker starts at zero and
        // whatever it holds at the end is exactly what it withdrew.
        vm.deal(address(this), BOUNTY);
        // Cancelling credits pendingWithdrawals directly, which is the balance
        // the attacker then withdraws — and re-enters from its receive hook.
        attacker.fund{value: BOUNTY}(_spec(2));

        uint256 liabilitiesBefore = relay.totalLiabilities();
        attacker.attack();

        assertTrue(attacker.reenterAttempts() > 0, "the receive hook did run");
        assertEq(attacker.reenterFailures(), attacker.reenterAttempts(), "every re-entry was refused");
        assertEq(address(attacker).balance, BOUNTY, "it got back exactly its own bounty");
        assertEq(relay.totalLiabilities(), liabilitiesBefore - BOUNTY, "and nothing else");
        assertGe(address(relay).balance, relay.totalLiabilities(), "still solvent");
        assertEq(uint256(uint8(relay.getTask(other).status)), uint256(uint8(ProofRelay.TaskStatus.Open)), "the other task is untouched");
    }

    function test_RevertWhen_ExpiringADisputeThatDoesNotExist() public {
        bytes32 taskId = _consensusTask();
        vm.expectRevert(ProofRelay.DisputeNotFound.selector);
        relay.expireDispute(taskId);
    }

    /* ── expiry and finalization ──────────────────────────────────────────── */

    function test_RevertWhen_ExpiringATaskBeforeItsRevealDeadline() public {
        bytes32 taskId = _revealedTask();

        vm.expectRevert(ProofRelay.DeadlineNotPassed.selector);
        relay.expireTask(taskId);
    }

    /**
     * With a short reveal set, `finalizeConsensus` and `expireTask` would both
     * become legal the second `revealDeadline` passes. Whoever landed first won:
     * expiry pays the revealers `conflictRateBps` — half — instead of the full
     * bounty a genuine consensus earns them, returns the rest to the creator,
     * and writes the terminal `Expired` status, which forecloses the dispute
     * window that is the only remedy for exactly that. `keeperGracePeriod` gives
     * the keeper an exclusive window to classify first.
     */
    function test_ExpireTask_IsClosedWhileTheKeeperStillHasItsWindow() public {
        bytes32 taskId = _createTask(BOUNTY, 3); // one slot never filled
        _commit(taskId, verifierA);
        _commit(taskId, verifierB);
        // The third slot never fills, so the commit phase closes on its deadline
        // rather than early — which is the state that makes the race reachable.
        vm.warp(uint256(relay.getTask(taskId).commitDeadline) + 1);
        _reveal(taskId, verifierA);
        _reveal(taskId, verifierB);

        (,,,,,,, uint32 keeperGracePeriod,,) = relay.params();
        uint256 revealDeadline = uint256(relay.getTask(taskId).revealDeadline);

        vm.warp(revealDeadline + 1);
        vm.expectRevert(ProofRelay.DeadlineNotPassed.selector);
        relay.expireTask(taskId);

        // The last second of the window still belongs to the keeper.
        vm.warp(revealDeadline + keeperGracePeriod);
        vm.expectRevert(ProofRelay.DeadlineNotPassed.selector);
        relay.expireTask(taskId);

        vm.prank(keeper);
        relay.finalizeConsensus(taskId, keccak256("result"), 1, _both(), 10_000);

        assertEq(
            relay.allocationOf(taskId, verifierA) + relay.allocationOf(taskId, verifierB),
            BOUNTY,
            "the revealers keep the whole bounty"
        );
        assertEq(relay.allocationOf(taskId, creator), 0, "the creator clawed nothing back");
    }

    /// Once the window closes, expiry is permissionless again — that is the point of it.
    function test_ExpireTask_OpensToAnyoneOnceTheGraceElapses() public {
        bytes32 taskId = _createTask(BOUNTY, 3);
        _commit(taskId, verifierA);
        vm.warp(uint256(relay.getTask(taskId).commitDeadline) + 1);
        _reveal(taskId, verifierA);

        (,,,,,,, uint32 keeperGracePeriod,,) = relay.params();
        vm.warp(uint256(relay.getTask(taskId).revealDeadline) + keeperGracePeriod + 1);

        relay.expireTask(taskId);
        assertEq(
            uint256(uint8(relay.getTask(taskId).status)),
            uint256(uint8(ProofRelay.TaskStatus.Expired)),
            "status"
        );
    }

    function test_RevertWhen_ExpiringASettledTask() public {
        bytes32 taskId = _consensusTask();
        vm.warp(uint256(relay.getTask(taskId).revealDeadline) + 1);

        vm.expectRevert(ProofRelay.InvalidStatus.selector);
        relay.expireTask(taskId);
    }

    function test_RevertWhen_FinalizingInsideTheDisputeWindow() public {
        bytes32 taskId = _consensusTask();
        vm.expectRevert(ProofRelay.WindowNotElapsed.selector);
        relay.finalizeTask(taskId);
    }

    function test_RevertWhen_FinalizingAnUnknownTask() public {
        vm.expectRevert(ProofRelay.TaskNotFound.selector);
        relay.finalizeTask(keccak256("nope"));
    }

    function test_RevertWhen_FinalizingATaskThatNeverReachedConsensus() public {
        bytes32 taskId = _createTask();
        vm.expectRevert(ProofRelay.InvalidStatus.selector);
        relay.finalizeTask(taskId);
    }

    /* ── cancellation ─────────────────────────────────────────────────────── */

    /**
     * Cancellation is gated on revealed work, not on a commitment. Any approved
     * verifier may commit to any open task, so gating on `committedCount == 0`
     * let one garbage commitment nobody can ever reveal brick cancellation and
     * hold the creator's escrow for the whole window.
     */
    function test_CancelTask_SurvivesACommitmentThatNobodyCanReveal() public {
        bytes32 taskId = _createTask();
        vm.prank(verifierA);
        relay.commitReport(taskId, bytes32(uint256(1))); // unrevealable by construction

        vm.prank(creator);
        relay.cancelTask(taskId);

        assertEq(
            uint256(uint8(relay.getTask(taskId).status)),
            uint256(uint8(ProofRelay.TaskStatus.Cancelled)),
            "cancelled"
        );
        assertEq(relay.pendingWithdrawals(creator), BOUNTY, "escrow refunded in full");
    }

    /// Revealed work is what cancellation must not walk away from.
    function test_RevertWhen_CancellingAfterAReveal() public {
        bytes32 taskId = _revealedTask();

        vm.prank(creator);
        vm.expectRevert(ProofRelay.InvalidStatus.selector);
        relay.cancelTask(taskId);
    }

    /// And once the commit window closes, the verifiers own the task.
    function test_RevertWhen_CancellingAfterTheCommitDeadline() public {
        bytes32 taskId = _createTask();
        vm.warp(uint256(relay.getTask(taskId).commitDeadline) + 1);

        vm.prank(creator);
        vm.expectRevert(ProofRelay.InvalidStatus.selector);
        relay.cancelTask(taskId);
    }

    function test_RevertWhen_CancellingAsANonCreator() public {
        bytes32 taskId = _createTask();
        vm.prank(stranger);
        vm.expectRevert(ProofRelay.NotAuthorized.selector);
        relay.cancelTask(taskId);
    }

    function test_RevertWhen_CancellingTwice() public {
        bytes32 taskId = _createTask();
        vm.prank(creator);
        relay.cancelTask(taskId);

        vm.prank(creator);
        vm.expectRevert(ProofRelay.InvalidStatus.selector);
        relay.cancelTask(taskId);
    }

    /* ── task creation bounds ─────────────────────────────────────────────── */

    function test_RevertWhen_BountyIsBelowTheMinimum() public {
        vm.prank(creator);
        vm.expectRevert(ProofRelay.InvalidBounty.selector);
        relay.createTask{value: 1e13}(_spec(2));
    }

    function test_RevertWhen_BountyIsZero() public {
        vm.prank(creator);
        vm.expectRevert(ProofRelay.InvalidBounty.selector);
        relay.createTask{value: 0}(_spec(2));
    }

    function test_RevertWhen_TooFewVerifiers() public {
        vm.prank(creator);
        vm.expectRevert(ProofRelay.InvalidVerifierCount.selector);
        relay.createTask{value: BOUNTY}(_spec(1));
    }

    function test_RevertWhen_TooManyVerifiers() public {
        vm.prank(creator);
        vm.expectRevert(ProofRelay.InvalidVerifierCount.selector);
        relay.createTask{value: BOUNTY}(_spec(17));
    }

    function test_RevertWhen_CommitWindowIsTooShort() public {
        vm.prank(creator);
        vm.expectRevert(ProofRelay.InvalidWindow.selector);
        relay.createTask{value: BOUNTY}(_windowSpec(29, 900, 900));
    }

    function test_RevertWhen_CommitWindowIsTooLong() public {
        vm.prank(creator);
        vm.expectRevert(ProofRelay.InvalidWindow.selector);
        relay.createTask{value: BOUNTY}(_windowSpec(2_592_001, 900, 900));
    }

    function test_RevertWhen_RevealWindowIsTooShort() public {
        vm.prank(creator);
        vm.expectRevert(ProofRelay.InvalidWindow.selector);
        relay.createTask{value: BOUNTY}(_windowSpec(900, 0, 900));
    }

    function test_RevertWhen_DisputeWindowIsTooLong() public {
        vm.prank(creator);
        vm.expectRevert(ProofRelay.InvalidWindow.selector);
        relay.createTask{value: BOUNTY}(_windowSpec(900, 900, 2_592_001));
    }

    function test_RevertWhen_ManifestPointerIsTooLong() public {
        ProofRelay.TaskSpec memory spec = _spec(2);
        spec.manifestPointer = _longPointer();

        vm.prank(creator);
        vm.expectRevert(ProofRelay.PointerTooLong.selector);
        relay.createTask{value: BOUNTY}(spec);
    }

    /* ── registry and admin ───────────────────────────────────────────────── */

    function test_RevertWhen_VerifierMetadataPointerIsTooLong() public {
        vm.prank(verifierC);
        vm.expectRevert(ProofRelay.PointerTooLong.selector);
        relay.registerVerifier(keccak256("m"), _longPointer());
    }

    function test_RevertWhen_SettingActiveWithoutRegistering() public {
        vm.prank(verifierC);
        vm.expectRevert(ProofRelay.NotRegistered.selector);
        relay.setVerifierActive(true);
    }

    function test_RevertWhen_WithdrawingMoreStakeThanHeld() public {
        vm.prank(verifierC);
        relay.registerVerifier{value: 1 ether}(keccak256("m"), "0g://m");

        vm.prank(verifierC);
        vm.expectRevert(ProofRelay.InsufficientStake.selector);
        relay.withdrawStake(1 ether + 1);
    }

    function test_RevertWhen_WithdrawingZeroStake() public {
        vm.prank(verifierA);
        vm.expectRevert(ProofRelay.InsufficientStake.selector);
        relay.withdrawStake(0);
    }

    function test_RevertWhen_NonAdminApprovesAVerifier() public {
        vm.prank(stranger);
        vm.expectRevert(ProofRelay.NotAuthorized.selector);
        relay.setVerifierApproval(verifierC, true);
    }

    function test_RevertWhen_KeeperApprovesAVerifier() public {
        vm.prank(keeper);
        vm.expectRevert(ProofRelay.NotAuthorized.selector);
        relay.setVerifierApproval(verifierC, true);
    }

    function test_RevertWhen_NonPauserPauses() public {
        vm.prank(stranger);
        vm.expectRevert(ProofRelay.NotAuthorized.selector);
        relay.pause();
    }

    function test_RevertWhen_NonAdminGrantsARole() public {
        bytes32 role = relay.KEEPER_ROLE();
        vm.prank(stranger);
        vm.expectRevert(ProofRelay.NotAuthorized.selector);
        relay.grantRole(role, stranger);
    }

    function test_RevertWhen_NonAdminRevokesARole() public {
        bytes32 role = relay.KEEPER_ROLE();
        vm.prank(keeper);
        vm.expectRevert(ProofRelay.NotAuthorized.selector);
        relay.revokeRole(role, keeper);
    }

    /* ── pause ────────────────────────────────────────────────────────────── */

    function test_RevertWhen_CreatingWhilePaused() public {
        vm.prank(admin);
        relay.pause();

        vm.prank(creator);
        vm.expectRevert(ProofRelay.ContractPaused.selector);
        relay.createTask{value: BOUNTY}(_spec(2));
    }

    function test_RevertWhen_CommittingWhilePaused() public {
        bytes32 taskId = _createTask();
        vm.prank(admin);
        relay.pause();

        vm.prank(verifierA);
        vm.expectRevert(ProofRelay.ContractPaused.selector);
        relay.commitReport(taskId, keccak256("c"));
    }

    function test_RevertWhen_RevealingWhilePaused() public {
        bytes32 taskId = _createTask();
        _commit(taskId, verifierA);
        _commit(taskId, verifierB);

        vm.prank(admin);
        relay.pause();

        vm.prank(verifierA);
        vm.expectRevert(ProofRelay.ContractPaused.selector);
        relay.revealReport(taskId, _reportHash(verifierA), "0g://report", _salt(verifierA));
    }

    /**
     * A pause must not censor the check on the pauser. PAUSER_ROLE is granted to
     * the admin, and on a single-key deployment that is the keeper — so pausing
     * closed the only remedy for a keeper misclassification while
     * `_disputeDeadline` kept running on wall-clock time and shut the window for
     * good. Everything a pause is actually for stays paused.
     */
    function test_OpenChallenge_StaysOpenWhilePaused() public {
        bytes32 taskId = _consensusTask();
        uint256 bond = _bond(BOUNTY);

        vm.prank(admin);
        relay.pause();

        vm.prank(creator);
        relay.openChallenge{value: bond}(taskId, keccak256("e"), "0g://e");

        assertEq(
            uint256(uint8(relay.getTask(taskId).status)),
            uint256(uint8(ProofRelay.TaskStatus.Disputed)),
            "the safety valve still opens"
        );

        // The paths a pause exists to stop are still stopped.
        vm.prank(creator);
        vm.expectRevert(ProofRelay.ContractPaused.selector);
        relay.createTask{value: BOUNTY}(_spec(2));
    }

    function test_RevertWhen_RegisteringWhilePaused() public {
        vm.prank(admin);
        relay.pause();

        vm.prank(verifierC);
        vm.expectRevert(ProofRelay.ContractPaused.selector);
        relay.registerVerifier(keccak256("m"), "0g://m");
    }
}

/**
 * Calls back into withdraw() from its receive hook. `nonReentrant` must make
 * every re-entry revert; the outer withdraw still succeeds.
 */
contract ReentrantBeneficiary {
    ProofRelay private immutable relay;
    uint256 public reenterAttempts;
    uint256 public reenterFailures;

    constructor(ProofRelay relay_) {
        relay = relay_;
    }

    function fund(ProofRelay.TaskSpec memory spec) external payable {
        bytes32 taskId = relay.createTask{value: msg.value}(spec);
        relay.cancelTask(taskId);
    }

    function attack() external {
        relay.withdraw();
    }

    receive() external payable {
        reenterAttempts += 1;
        try relay.withdraw() {} catch {
            reenterFailures += 1;
        }
    }
}

