// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ProofRelay} from "../src/ProofRelay.sol";
import {ProofRelayFixture, RevertingReceiver, ReentrantReceiver} from "./Base.t.sol";

/// The happy paths of every lifecycle branch the threat model claims coverage for.
contract ProofRelayUnitTest is ProofRelayFixture {
    /* ── creation ─────────────────────────────────────────────────────────── */

    function test_CreateTask_EscrowsBountyAndOpensTask() public {
        bytes32 taskId = _createTask();
        ProofRelay.Task memory task = relay.getTask(taskId);

        assertEq(task.creator, creator, "creator");
        assertEq(task.bounty, BOUNTY, "bounty");
        assertEq(task.verifierCount, 2, "verifierCount");
        assertEq(uint256(uint8(task.status)), uint256(uint8(ProofRelay.TaskStatus.Open)), "status");
        assertEq(task.manifestHash, keccak256("manifest"), "manifestHash");
        assertEq(address(relay).balance, BOUNTY, "escrow held");
        assertEq(relay.totalLiabilities(), BOUNTY, "liability recorded");
    }

    function test_CreateTask_DerivesIdFromChainCreatorAndNonce() public {
        bytes32 expected = keccak256(abi.encode(block.chainid, address(relay), creator, uint256(0)));
        assertEq(_createTask(), expected, "taskId encoding");
    }

    function test_CreateTask_BumpsCreatorNonceSoIdsDiffer() public {
        bytes32 first = _createTask();
        bytes32 second = _createTask();

        assertEq(relay.creatorNonce(creator), 2, "nonce");
        assertTrue(first != second, "ids differ");
    }

    function test_CreateTask_SetsDeadlinesFromTheWindows() public {
        uint256 start = block.timestamp;
        ProofRelay.Task memory task = relay.getTask(_createTask());

        assertEq(task.commitDeadline, start + COMMIT_WINDOW, "commitDeadline");
        assertEq(task.revealDeadline, start + COMMIT_WINDOW + REVEAL_WINDOW, "revealDeadline");
        assertEq(task.disputeWindow, DISPUTE_WINDOW, "disputeWindow is a duration");
    }

    /**
     * Cancelling credits the creator's withdrawable balance directly — it does
     * not allocate. Asserting `allocationOf` here would pass against a plausible
     * design and fail against the one that is deployed, which is how the
     * difference was found in the first place.
     */
    function test_CancelTask_CreditsTheCreatorDirectly() public {
        bytes32 taskId = _createTask();

        vm.expectEmit(true, true, false, true);
        emit ProofRelay.TaskCancelled(taskId, creator, BOUNTY);
        vm.prank(creator);
        relay.cancelTask(taskId);

        assertEq(uint256(uint8(_status(taskId))), uint256(uint8(ProofRelay.TaskStatus.Cancelled)), "status");
        assertEq(uint256(uint8(relay.getTask(taskId).outcome)), uint256(uint8(ProofRelay.Outcome.Cancelled)), "outcome");
        assertEq(relay.allocationOf(taskId, creator), 0, "a cancellation never allocates");
        assertEq(relay.pendingWithdrawals(creator), BOUNTY, "refund is withdrawable");
    }

    /**
     * `refundCreator` pays the creator's entire pending balance, not this
     * task's share of it. Two cancelled tasks, one call, both bounties paid.
     */
    function test_RefundCreator_PaysTheWholePendingBalance() public {
        bytes32 first = _createTask();
        bytes32 second = _createTask();

        vm.startPrank(creator);
        relay.cancelTask(first);
        relay.cancelTask(second);
        vm.stopPrank();
        assertEq(relay.pendingWithdrawals(creator), BOUNTY * 2, "both bounties are pending");

        uint256 before = creator.balance;
        vm.expectEmit(true, true, false, true);
        emit ProofRelay.RefundClaimed(first, creator, BOUNTY * 2);
        vm.prank(creator);
        relay.refundCreator(first);

        assertEq(creator.balance - before, BOUNTY * 2, "one call paid out both");
        assertEq(relay.pendingWithdrawals(creator), 0, "nothing is left pending");
    }

    /* ── commit and reveal ────────────────────────────────────────────────── */

    function test_CommitReport_RecordsCommitmentAndMovesToCommitting() public {
        bytes32 taskId = _createTask();
        _commit(taskId, verifierA);

        ProofRelay.Report memory report = relay.getReport(taskId, verifierA);
        assertEq(report.verifier, verifierA, "verifier");
        assertEq(
            report.commitment,
            relay.computeCommitment(taskId, verifierA, _reportHash(verifierA), _salt(verifierA)),
            "commitment"
        );
        assertFalse(report.revealed, "not revealed yet");
        assertEq(relay.getTask(taskId).committedCount, 1, "committedCount");
        assertEq(uint256(uint8(_status(taskId))), uint256(uint8(ProofRelay.TaskStatus.Committing)), "status");
        assertEq(relay.getTaskVerifiers(taskId).length, 1, "verifier list");
    }

    function test_RevealReport_OpensOnceEveryVerifierHasCommitted() public {
        bytes32 taskId = _createTask();
        _commit(taskId, verifierA);
        _commit(taskId, verifierB);
        _reveal(taskId, verifierA);

        ProofRelay.Report memory report = relay.getReport(taskId, verifierA);
        assertTrue(report.revealed, "revealed");
        assertEq(report.reportHash, _reportHash(verifierA), "reportHash");
        assertEq(relay.getTask(taskId).revealedCount, 1, "revealedCount");
        assertEq(uint256(uint8(_status(taskId))), uint256(uint8(ProofRelay.TaskStatus.Revealing)), "status");
    }

    function test_RevealReport_OpensWhenTheCommitWindowClosesShortOfQuorum() public {
        bytes32 taskId = _createTask();
        _commit(taskId, verifierA);

        vm.warp(uint256(relay.getTask(taskId).commitDeadline) + 1);
        _reveal(taskId, verifierA);

        assertTrue(relay.getReport(taskId, verifierA).revealed, "late-quorum reveal allowed");
    }

    function test_RevealReport_StoresThePointerForRetrieval() public {
        bytes32 taskId = _revealedTask();
        assertTrue(
            keccak256(bytes(relay.getReport(taskId, verifierB).reportPointer)) == keccak256(bytes("0g://report")),
            "pointer stored"
        );
    }

    /* ── settlement ───────────────────────────────────────────────────────── */

    function test_FinalizeConsensus_SplitsTheBountyBetweenRevealers() public {
        bytes32 taskId = _consensusTask();

        assertEq(relay.allocationOf(taskId, verifierA), BOUNTY / 2, "A share");
        assertEq(relay.allocationOf(taskId, verifierB), BOUNTY / 2, "B share");
        assertEq(relay.allocationOf(taskId, creator), 0, "no remainder");
        assertEq(uint256(uint8(relay.getTask(taskId).outcome)), uint256(uint8(ProofRelay.Outcome.Consensus)), "outcome");
        assertEq(relay.getTask(taskId).rewardBps, 10_000, "rewardBps");
    }

    /**
     * A partial reward was the keeper choosing the amount, which the trust model
     * says it never does — and the offchain keeper has only ever sent 10000
     * (`CONSENSUS_REWARD_BPS`), which is what both settled tasks on the live
     * deployment recorded. What still returns to the creator is rounding dust,
     * because an indivisible bounty cannot split evenly.
     */
    function test_FinalizeConsensus_RefusesAPartialRewardAndReturnsOnlyDust() public {
        bytes32 taskId = _revealedTask();

        vm.prank(keeper);
        vm.expectRevert(ProofRelay.InvalidRewardBps.selector);
        relay.finalizeConsensus(taskId, keccak256("result"), 1, _both(), 6_000);

        vm.prank(keeper);
        relay.finalizeConsensus(taskId, keccak256("result"), 1, _both(), 10_000);

        uint256 share = BOUNTY / 2;
        assertEq(relay.allocationOf(taskId, verifierA), share, "A share");
        assertEq(relay.allocationOf(taskId, verifierB), share, "B share");
        assertEq(relay.allocationOf(taskId, creator), BOUNTY - share * 2, "only rounding dust");
        assertEq(
            relay.allocationOf(taskId, verifierA)
                + relay.allocationOf(taskId, verifierB)
                + relay.allocationOf(taskId, creator),
            BOUNTY,
            "nothing created or destroyed"
        );
    }

    function test_FinalizeConsensus_ConflictPaysTheReducedRateToEveryRevealer() public {
        bytes32 taskId = _revealedTask();

        vm.prank(keeper);
        relay.finalizeConsensus(taskId, keccak256("result"), 2, _none(), 0);

        (uint16 conflictRateBps,,,,,,,,,) = relay.params();
        uint256 pool = BOUNTY * conflictRateBps / 10_000;

        assertEq(relay.allocationOf(taskId, verifierA), pool / 2, "A conflict rate");
        assertEq(relay.allocationOf(taskId, verifierB), pool / 2, "B conflict rate");
        assertEq(relay.allocationOf(taskId, creator), BOUNTY - pool, "creator keeps the rest");
        assertEq(relay.getTask(taskId).rewardBps, 0, "no reward rate on a conflict");
    }

    function test_FinalizeConsensus_NoQuorumRefundsInFull() public {
        bytes32 taskId = _createTask();
        _skipPastReveal(taskId);

        vm.prank(keeper);
        relay.finalizeConsensus(taskId, bytes32(0), 3, _none(), 0);

        assertEq(relay.allocationOf(taskId, creator), BOUNTY, "full refund");
    }

    function test_FinalizeConsensus_OpensTheDisputeWindow() public {
        bytes32 taskId = _consensusTask();
        ProofRelay.Task memory task = relay.getTask(taskId);

        assertEq(task.consensusAt, block.timestamp, "consensusAt");
        assertEq(uint256(uint8(task.status)), uint256(uint8(ProofRelay.TaskStatus.Consensus)), "status");
    }

    function test_FinalizeTask_IsPermissionlessOnceTheWindowCloses() public {
        bytes32 taskId = _consensusTask();
        _skipPastDispute(taskId);

        vm.prank(stranger);
        relay.finalizeTask(taskId);

        assertEq(uint256(uint8(_status(taskId))), uint256(uint8(ProofRelay.TaskStatus.Finalized)), "finalized");
    }

    function test_ClaimReward_AutoFinalizesAfterTheDisputeWindow() public {
        bytes32 taskId = _consensusTask();
        _skipPastDispute(taskId);

        vm.prank(verifierA);
        relay.claimReward(taskId);

        assertEq(uint256(uint8(_status(taskId))), uint256(uint8(ProofRelay.TaskStatus.Finalized)), "auto-finalized");
        assertEq(relay.pendingWithdrawals(verifierA), BOUNTY / 2, "claimable");
        assertEq(relay.allocationOf(taskId, verifierA), 0, "allocation consumed");
    }

    function test_Withdraw_PaysTheCallerAndClearsTheLiability() public {
        bytes32 taskId = _consensusTask();
        _skipPastDispute(taskId);

        vm.prank(verifierA);
        relay.claimReward(taskId);

        uint256 before = verifierA.balance;
        vm.prank(verifierA);
        relay.withdraw();

        assertEq(verifierA.balance, before + BOUNTY / 2, "paid out");
        assertEq(relay.pendingWithdrawals(verifierA), 0, "balance cleared");
        assertEq(address(relay).balance, relay.totalLiabilities(), "still solvent");
    }

    /* ── disputes ─────────────────────────────────────────────────────────── */

    function test_OpenChallenge_BondsAndMovesTaskToDisputed() public {
        bytes32 taskId = _disputedTask();
        ProofRelay.Dispute memory dispute = relay.getDispute(taskId);

        assertEq(dispute.challenger, creator, "challenger");
        assertEq(dispute.bond, _bond(BOUNTY), "bond");
        assertEq(uint256(uint8(_status(taskId))), uint256(uint8(ProofRelay.TaskStatus.Disputed)), "status");
        assertEq(address(relay).balance, BOUNTY + _bond(BOUNTY), "bond escrowed");
    }

    function test_OpenChallenge_AcceptsATaskVerifier() public {
        bytes32 taskId = _consensusTask();
        uint256 bond = _bond(BOUNTY);
        // The first half of the dispute window belongs to the creator.
        vm.warp(uint256(relay.getTask(taskId).consensusAt) + DISPUTE_WINDOW / 2 + 1);

        vm.prank(verifierB);
        relay.openChallenge{value: bond}(taskId, keccak256("evidence"), "0g://evidence");

        assertEq(relay.getDispute(taskId).challenger, verifierB, "verifier may challenge");
    }

    function test_ResolveDispute_UpheldReallocatesInsideTheEscrow() public {
        bytes32 taskId = _disputedTask();
        uint256 bond = _bond(BOUNTY);

        vm.prank(adjudicator);
        relay.resolveDispute(taskId, true, keccak256("adj"), "0g://adj", _one(verifierB), keccak256("reason"));

        uint256 challengerReward = BOUNTY * 1_000 / 10_000;
        assertEq(relay.allocationOf(taskId, creator), bond + challengerReward, "challenger made whole");
        assertEq(relay.allocationOf(taskId, verifierB), BOUNTY - challengerReward, "upheld beneficiary");
        assertEq(relay.allocationOf(taskId, verifierA), 0, "wrong verifier unwound");
        assertEq(relay.getTask(taskId).resultHash, keccak256("reason"), "reason hash recorded");
        assertEq(uint256(uint8(_status(taskId))), uint256(uint8(ProofRelay.TaskStatus.Finalized)), "finalized");
    }

    function test_ResolveDispute_RejectedLeavesTheConsensusAllocationIntact() public {
        bytes32 taskId = _disputedTask();
        uint256 bond = _bond(BOUNTY);

        vm.prank(adjudicator);
        relay.resolveDispute(taskId, false, keccak256("adj"), "0g://adj", _none(), keccak256("reason"));

        uint256 defended = bond * 5_000 / 10_000;
        assertEq(relay.allocationOf(taskId, verifierA), BOUNTY / 2 + defended / 2, "A keeps its share plus bond");
        assertEq(relay.allocationOf(taskId, verifierB), BOUNTY / 2 + defended / 2, "B keeps its share plus bond");
        assertEq(relay.allocationOf(taskId, creator), bond - defended, "rest of the bond returns to the creator");
        assertFalse(relay.getDispute(taskId).upheld, "rejected");
    }

    function test_ResolveDispute_StoresTheAdjudicationRecord() public {
        bytes32 taskId = _disputedTask();

        vm.prank(adjudicator);
        relay.resolveDispute(taskId, true, keccak256("adj"), "0g://adj", _none(), keccak256("reason"));

        ProofRelay.Dispute memory dispute = relay.getDispute(taskId);
        assertTrue(dispute.resolved, "resolved");
        assertEq(dispute.adjudicationHash, keccak256("adj"), "adjudicationHash");
        assertTrue(
            keccak256(bytes(dispute.adjudicationPointer)) == keccak256(bytes("0g://adj")), "adjudicationPointer"
        );
    }

    /**
     * An unanswered challenge froze every allocation on the task for the whole
     * adjudication window. A full refund made the bond a free option — open a
     * challenge with no intention of pursuing it, deny the payout, take the bond
     * back — so the verifiers it froze keep `adjudicatorSplitBps` of it.
     */
    function test_ExpireDispute_ForfeitsPartOfTheBondAndFinalizes() public {
        bytes32 taskId = _disputedTask(); // the creator is the challenger here
        uint256 bond = _bond(BOUNTY);
        (,,, uint16 adjudicatorSplitBps,,,,,,) = relay.params();
        uint256 shareOfForfeit = (bond * adjudicatorSplitBps / 10_000) / 2; // two revealers

        vm.warp(uint256(relay.getDispute(taskId).deadline) + 1);

        vm.prank(stranger);
        relay.expireDispute(taskId);

        assertEq(relay.allocationOf(taskId, creator), bond - shareOfForfeit * 2, "only the rest returns");
        assertEq(relay.allocationOf(taskId, verifierA), BOUNTY / 2 + shareOfForfeit, "A: consensus plus compensation");
        assertEq(relay.allocationOf(taskId, verifierB), BOUNTY / 2 + shareOfForfeit, "B: consensus plus compensation");
        assertEq(uint256(uint8(_status(taskId))), uint256(uint8(ProofRelay.TaskStatus.Finalized)), "finalized");
    }

    /* ── expiry ───────────────────────────────────────────────────────────── */

    function test_ExpireTask_PaysTheConflictRateToRevealersWhenTheKeeperIsGone() public {
        bytes32 taskId = _revealedTask();
        (,,,,,,, uint32 keeperGracePeriod,,) = relay.params();
        vm.warp(uint256(relay.getTask(taskId).revealDeadline) + keeperGracePeriod + 1);

        vm.prank(stranger);
        relay.expireTask(taskId);

        (uint16 conflictRateBps,,,,,,,,,) = relay.params();
        uint256 pool = BOUNTY * conflictRateBps / 10_000;

        assertEq(relay.allocationOf(taskId, verifierA), pool / 2, "A paid");
        assertEq(relay.allocationOf(taskId, creator), BOUNTY - pool, "creator refunded the rest");
        assertEq(uint256(uint8(_status(taskId))), uint256(uint8(ProofRelay.TaskStatus.Expired)), "expired");
        assertEq(uint256(uint8(relay.getTask(taskId).outcome)), uint256(uint8(ProofRelay.Outcome.Conflict)), "outcome");
    }

    /**
     * One second past the reveal deadline, with no grace to wait out — and the
     * outcome is `Expired`, which is the value the live contract stored when a
     * task nobody revealed on was expired against it.
     */
    /**
     * `_settleUpheld` calls `_reclaimAll`, so an upheld challenge unwinds every
     * allocation the consensus made. The task's verdict has to move with the
     * money: leaving `outcome` at Consensus made `displayStatus` — which reads
     * Finalized + Consensus as VERIFIED — render an overturned claim as a
     * successful one, both onchain and in every client reading the struct.
     */
    function test_ResolveDispute_UpheldStopsReportingTheOverturnedConsensus() public {
        bytes32 taskId = _disputedTask();
        assertEq(
            uint256(uint8(relay.getTask(taskId).outcome)),
            uint256(uint8(ProofRelay.Outcome.Consensus)),
            "precondition: the consensus stands before adjudication"
        );

        vm.prank(adjudicator);
        relay.resolveDispute(taskId, true, keccak256("adj"), "0g://adj", _one(verifierB), keccak256("why"));

        ProofRelay.Task memory task = relay.getTask(taskId);
        assertEq(uint256(uint8(task.status)), uint256(uint8(ProofRelay.TaskStatus.Finalized)), "status");
        assertEq(uint256(uint8(task.outcome)), uint256(uint8(ProofRelay.Outcome.Conflict)), "outcome moved");
        assertEq(uint256(task.rewardBps), 0, "the unwound split describes nothing");
    }

    /// A rejected challenge leaves the allocations standing, so the record stands too.
    function test_ResolveDispute_RejectedKeepsTheConsensusRecord() public {
        bytes32 taskId = _disputedTask();

        vm.prank(adjudicator);
        relay.resolveDispute(taskId, false, keccak256("adj"), "0g://adj", _both(), keccak256("why"));

        ProofRelay.Task memory task = relay.getTask(taskId);
        assertEq(uint256(uint8(task.outcome)), uint256(uint8(ProofRelay.Outcome.Consensus)), "outcome kept");
        assertEq(uint256(task.rewardBps), 10_000, "split kept");
    }

    /**
     * Nothing ever finalized a Conflict where committedCount != revealedCount and
     * asserted the amounts, so the "only revealers are paid" rule was unpinned:
     * a mutation paying every committed verifier would have passed the suite.
     */
    function test_FinalizeConsensus_ConflictPaysOnlyTheVerifiersThatRevealed() public {
        bytes32 taskId = _createTask(BOUNTY, 3);
        _commit(taskId, verifierA);
        _commit(taskId, verifierB);
        vm.warp(uint256(relay.getTask(taskId).commitDeadline) + 1);
        _reveal(taskId, verifierA); // B committed and stayed silent

        vm.warp(uint256(relay.getTask(taskId).revealDeadline) + 1);
        vm.prank(keeper);
        relay.finalizeConsensus(taskId, keccak256("result"), 2 /* Conflict */, _none(), 0);

        (uint16 conflictRateBps,,,,,,,,,) = relay.params();
        uint256 pool = BOUNTY * conflictRateBps / 10_000;

        assertEq(relay.allocationOf(taskId, verifierA), pool, "the one revealer takes the whole pool");
        assertEq(relay.allocationOf(taskId, verifierB), 0, "a committed verifier that stayed silent earns nothing");
        assertEq(relay.allocationOf(taskId, creator), BOUNTY - pool, "the rest returns to the creator");
        assertEq(
            relay.allocationOf(taskId, verifierA)
                + relay.allocationOf(taskId, verifierB)
                + relay.allocationOf(taskId, creator),
            BOUNTY,
            "nothing created or destroyed"
        );
    }

    /**
     * Every deadline here is a strict `>`, and the suite tested each one a second
     * past the edge — so a mutation to `>=` survived. This pins the exact
     * boundary block: reveal opens on the second AFTER the commit deadline.
     */
    function test_RevealOpens_OnTheSecondAfterTheCommitDeadline() public {
        bytes32 taskId = _createTask(BOUNTY, 3); // a slot stays unfilled, so the deadline decides
        _commit(taskId, verifierA);
        uint256 commitDeadline = uint256(relay.getTask(taskId).commitDeadline);

        vm.warp(commitDeadline);
        vm.prank(verifierA);
        vm.expectRevert(ProofRelay.RevealNotOpen.selector);
        relay.revealReport(taskId, _reportHash(verifierA), "0g://report", _salt(verifierA));

        vm.warp(commitDeadline + 1);
        _reveal(taskId, verifierA);
        assertEq(relay.getTask(taskId).revealedCount, 1, "revealed on the next second");
    }

    /// And the dispute window is open ON its deadline, closed the second after.
    function test_DisputeWindow_ClosesTheSecondAfterItsDeadline() public {
        bytes32 open_ = _consensusTask();
        ProofRelay.Task memory t = relay.getTask(open_);
        // Read the bond before the prank: an external call in the argument list
        // consumes it and the challenge arrives from this test contract.
        uint256 bond = _bond(BOUNTY);
        vm.warp(uint256(t.consensusAt) + uint256(t.disputeWindow));
        vm.prank(creator);
        relay.openChallenge{value: bond}(open_, keccak256("e"), "0g://e");
        assertEq(relay.getDispute(open_).challenger, creator, "still open on the deadline");
    }

    function test_RevertWhen_ChallengingOneSecondPastTheDeadline() public {
        bytes32 late = _consensusTask();
        ProofRelay.Task memory t = relay.getTask(late);
        uint256 bond = _bond(BOUNTY);
        vm.warp(uint256(t.consensusAt) + uint256(t.disputeWindow) + 1);
        vm.prank(creator);
        vm.expectRevert(ProofRelay.DeadlinePassed.selector);
        relay.openChallenge{value: bond}(late, keccak256("e"), "0g://e");
    }

    function test_ExpireTask_RefundsInFullWhenNobodyRevealed() public {
        bytes32 taskId = _createTask();
        (,,,,,,, uint32 keeperGracePeriod,,) = relay.params();
        vm.warp(uint256(relay.getTask(taskId).revealDeadline) + keeperGracePeriod + 1);

        relay.expireTask(taskId);

        assertEq(relay.allocationOf(taskId, creator), BOUNTY, "full refund");
        assertEq(uint256(uint8(relay.getTask(taskId).outcome)), uint256(uint8(ProofRelay.Outcome.Expired)), "outcome");
        assertEq(uint256(uint8(relay.getTask(taskId).status)), uint256(uint8(ProofRelay.TaskStatus.Expired)), "status");
    }

    /// The boundary is exclusive: at the deadline itself it is still refused.
    function test_ExpireTask_IsRefusedAtTheDeadlineItself() public {
        bytes32 taskId = _createTask();
        vm.warp(uint256(relay.getTask(taskId).revealDeadline));

        vm.expectRevert(ProofRelay.DeadlineNotPassed.selector);
        relay.expireTask(taskId);
    }

    /* ── registry ─────────────────────────────────────────────────────────── */

    function test_RegisterVerifier_IsSelfServiceAndStakeIsOptional() public {
        vm.prank(verifierC);
        relay.registerVerifier{value: 1 ether}(keccak256("meta"), "0g://meta");

        ProofRelay.VerifierRecord memory record = relay.getVerifier(verifierC);
        assertTrue(record.registered, "registered");
        assertFalse(record.approved, "approval is a separate, admin-only step");
        assertTrue(record.active, "active by default");
        assertEq(record.stake, 1 ether, "stake");
        assertEq(relay.totalLiabilities(), 1 ether, "stake is a liability");
    }

    function test_SetVerifierApproval_AdminOnly() public {
        vm.prank(admin);
        relay.setVerifierApproval(verifierC, true);
        assertTrue(relay.getVerifier(verifierC).approved, "approved");

        vm.prank(admin);
        relay.setVerifierApproval(verifierC, false);
        assertFalse(relay.getVerifier(verifierC).approved, "revoked");
    }

    function test_SetVerifierActive_TakesAVerifierOutOfThePool() public {
        vm.prank(verifierA);
        relay.setVerifierActive(false);
        assertFalse(relay.getVerifier(verifierA).active, "inactive");

        vm.prank(verifierA);
        relay.setVerifierActive(true);
        assertTrue(relay.getVerifier(verifierA).active, "active again");
    }

    function test_WithdrawStake_MovesStakeIntoThePendingBalance() public {
        vm.prank(verifierC);
        relay.registerVerifier{value: 1 ether}(keccak256("meta"), "0g://meta");

        vm.prank(verifierC);
        relay.withdrawStake(0.4 ether);

        assertEq(relay.getVerifier(verifierC).stake, 0.6 ether, "stake reduced");
        assertEq(relay.pendingWithdrawals(verifierC), 0.4 ether, "withdrawable");

        vm.prank(verifierC);
        relay.withdraw();
        assertEq(address(relay).balance, relay.totalLiabilities(), "still solvent");
    }

    /* ── admin ────────────────────────────────────────────────────────────── */

    function test_RoleConstants_MatchThePinnedValues() public view {
        assertEq(relay.KEEPER_ROLE(), keccak256("PROOFRELAY_KEEPER"), "KEEPER_ROLE preimage");
        assertEq(
            relay.KEEPER_ROLE(),
            0xd4d16a49e1624cc74b234de10748b491e8c488a801512216f5e9ecca17fd3650,
            "KEEPER_ROLE pinned to the live contract"
        );
        assertEq(relay.ADJUDICATOR_ROLE(), keccak256("PROOFRELAY_ADJUDICATOR"), "ADJUDICATOR_ROLE preimage");
        assertEq(
            relay.ADJUDICATOR_ROLE(),
            0xb4022bc6266e0ef1404f8abf40a5683ecf9b81f8e2078d5ff865da4a4a6e949e,
            "ADJUDICATOR_ROLE pinned to the live contract"
        );
        assertEq(relay.PAUSER_ROLE(), keccak256("PROOFRELAY_PAUSER"), "PAUSER_ROLE preimage");
        assertEq(
            relay.PAUSER_ROLE(),
            0x4df6ff9a5a7716f8314e49a612d0175b66b524792c70bee8931455dab1446daa,
            "PAUSER_ROLE pinned to the live contract"
        );
        assertEq(relay.DEFAULT_ADMIN_ROLE(), bytes32(0), "DEFAULT_ADMIN_ROLE");
    }

    function test_Constants_MatchThePinnedValues() public view {
        assertEq(relay.MIN_WINDOW(), 30, "MIN_WINDOW");
        assertEq(relay.MAX_WINDOW(), 2_592_000, "MAX_WINDOW");
        assertEq(relay.MIN_VERIFIERS(), 2, "MIN_VERIFIERS");
        assertEq(relay.MAX_VERIFIERS(), 16, "MAX_VERIFIERS");
        assertEq(relay.MAX_DISPUTE_WINDOW(), 2_592_000, "MAX_DISPUTE_WINDOW");
        assertEq(relay.BPS_DENOMINATOR(), 10_000, "BPS_DENOMINATOR");
        assertEq(relay.MAX_POINTER_BYTES(), 256, "MAX_POINTER_BYTES");
    }

    function test_Params_MatchTheLiveDeployment() public view {
        (
            uint16 conflictRateBps,
            uint16 challengeBondBps,
            uint16 challengerRewardBps,
            uint16 adjudicatorSplitBps,
            uint16 verifierSlashBps,
            uint96 minBounty,
            uint96 minVerifierStake,
            uint32 keeperGracePeriod,
            uint32 adjudicationWindow,
            uint32 claimGracePeriod
        ) = relay.params();

        assertEq(conflictRateBps, 5_000, "conflictRateBps");
        assertEq(challengeBondBps, 1_000, "challengeBondBps");
        assertEq(challengerRewardBps, 1_000, "challengerRewardBps");
        assertEq(adjudicatorSplitBps, 5_000, "adjudicatorSplitBps");
        assertEq(verifierSlashBps, 0, "verifierSlashBps");
        assertEq(minBounty, 1e14, "minBounty");
        assertEq(minVerifierStake, 0, "minVerifierStake");
        assertEq(keeperGracePeriod, 259_200, "keeperGracePeriod");
        assertEq(adjudicationWindow, 604_800, "adjudicationWindow");
        assertEq(claimGracePeriod, 604_800, "claimGracePeriod");
    }

    function test_Roles_GrantedAtDeployment() public view {
        assertTrue(relay.hasRole(relay.DEFAULT_ADMIN_ROLE(), admin), "admin");
        assertTrue(relay.hasRole(relay.PAUSER_ROLE(), admin), "pauser");
        assertTrue(relay.hasRole(relay.KEEPER_ROLE(), keeper), "keeper");
        assertTrue(relay.hasRole(relay.ADJUDICATOR_ROLE(), adjudicator), "adjudicator");
        assertFalse(relay.hasRole(relay.KEEPER_ROLE(), admin), "admin is not a keeper");
    }

    function test_GrantAndRevokeRole_RotatesTheKeeper() public {
        bytes32 role = relay.KEEPER_ROLE();

        vm.prank(admin);
        relay.grantRole(role, stranger);
        assertTrue(relay.hasRole(role, stranger), "granted");

        vm.prank(admin);
        relay.revokeRole(role, keeper);
        assertFalse(relay.hasRole(relay.KEEPER_ROLE(), keeper), "revoked");
    }

    function test_Pause_BlocksNewEscrowButNotSettlement() public {
        bytes32 taskId = _consensusTask();

        vm.prank(admin);
        relay.pause();
        assertTrue(relay.paused(), "paused");

        _skipPastDispute(taskId);

        // Finalization, claiming and withdrawal all stay open: an admin must
        // never be able to trap escrow.
        relay.finalizeTask(taskId);
        vm.prank(verifierA);
        relay.claimReward(taskId);
        vm.prank(verifierA);
        relay.withdraw();

        assertEq(relay.pendingWithdrawals(verifierA), 0, "paid while paused");
    }

    function test_Pause_DoesNotBlockExpiryPaths() public {
        bytes32 taskId = _revealedTask();
        (,,,,,,, uint32 keeperGracePeriod,,) = relay.params();

        vm.prank(admin);
        relay.pause();
        vm.warp(uint256(relay.getTask(taskId).revealDeadline) + keeperGracePeriod + 1);

        vm.prank(stranger);
        relay.expireTask(taskId);
        assertEq(uint256(uint8(_status(taskId))), uint256(uint8(ProofRelay.TaskStatus.Expired)), "expired");
    }

    function test_Unpause_RestoresCreation() public {
        vm.prank(admin);
        relay.pause();
        vm.prank(admin);
        relay.unpause();

        _createTask();
        assertFalse(relay.paused(), "unpaused");
    }

    /* ── payout griefing ──────────────────────────────────────────────────── */

    function test_RevertingBeneficiary_BlocksOnlyItself() public {
        RevertingReceiver bad = new RevertingReceiver();
        vm.deal(address(bad), 1 ether);

        vm.prank(address(bad));
        relay.registerVerifier(keccak256("bad"), "0g://bad");
        vm.prank(admin);
        relay.setVerifierApproval(address(bad), true);

        bytes32 taskId = _createTask();
        _commit(taskId, verifierA);
        _commit(taskId, address(bad));
        _reveal(taskId, verifierA);

        _reveal(taskId, address(bad));

        address[] memory set = new address[](2);
        set[0] = verifierA;
        set[1] = address(bad);
        vm.prank(keeper);
        relay.finalizeConsensus(taskId, keccak256("result"), 1, set, 10_000);
        _skipPastDispute(taskId);

        bad.claim(relay, taskId);
        vm.expectRevert(ProofRelay.TransferFailed.selector);
        bad.withdraw(relay);

        // The honest verifier is unaffected, and the stuck balance stays owed.
        vm.prank(verifierA);
        relay.claimReward(taskId);
        uint256 before = verifierA.balance;
        vm.prank(verifierA);
        relay.withdraw();

        assertEq(verifierA.balance, before + BOUNTY / 2, "honest verifier paid");
        assertEq(relay.pendingWithdrawals(address(bad)), BOUNTY / 2, "bad receiver still owed");
        assertGe(address(relay).balance, relay.totalLiabilities(), "solvent");
    }

    function test_Withdraw_IsNotReentrant() public {
        ReentrantReceiver attacker = new ReentrantReceiver(relay);
        vm.deal(address(attacker), 1 ether);

        vm.prank(address(attacker));
        relay.registerVerifier{value: 1 ether}(keccak256("re"), "0g://re");

        vm.prank(address(attacker));
        relay.withdrawStake(1 ether);

        // The nested withdraw() reverts, which bubbles up through the payout.
        vm.expectRevert(ProofRelay.TransferFailed.selector);
        attacker.withdraw();

        assertEq(relay.pendingWithdrawals(address(attacker)), 1 ether, "nothing drained");
    }
}
