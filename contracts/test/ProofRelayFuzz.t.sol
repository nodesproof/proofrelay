// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ProofRelay} from "../src/ProofRelay.sol";
import {ProofRelayFixture} from "./Base.t.sol";

/**
 * Conservation properties over randomized amounts. Every branch that moves
 * money is checked the same way: what the contract holds equals what it says it
 * owes, and what a task allocated equals what was escrowed against it.
 */
contract ProofRelayFuzzTest is ProofRelayFixture {
    uint256 internal constant MIN_BOUNTY = 1e14;
    uint256 internal constant MAX_BOUNTY = 10_000 ether;

    function _bound(uint256 x, uint256 lo, uint256 hi) internal pure returns (uint256) {
        return lo + (x % (hi - lo + 1));
    }

    function _fund(uint256 amount) internal {
        vm.deal(creator, amount);
    }

    function _allocatedOn(bytes32 taskId) internal view returns (uint256 total) {
        total = relay.allocationOf(taskId, creator) + relay.allocationOf(taskId, verifierA)
            + relay.allocationOf(taskId, verifierB);
    }

    function testFuzz_EscrowEqualsLiabilitiesAfterCreation(uint256 seed) public {
        uint256 bounty = _bound(seed, MIN_BOUNTY, MAX_BOUNTY);
        _fund(bounty);

        bytes32 taskId = _createTask(bounty, 2);

        assertEq(relay.getTask(taskId).bounty, bounty, "bounty stored");
        assertEq(address(relay).balance, bounty, "escrow held");
        assertEq(relay.totalLiabilities(), bounty, "liability recorded");
    }

    function testFuzz_ConsensusPayoutIsConserved(uint256 seed, uint16 rewardBpsSeed) public {
        uint256 bounty = _bound(seed, MIN_BOUNTY, MAX_BOUNTY);
        uint16 rewardBps = uint16(_bound(rewardBpsSeed, 0, 10_000));
        _fund(bounty);

        bytes32 taskId = _createTask(bounty, 2);
        _commit(taskId, verifierA);
        _commit(taskId, verifierB);
        _reveal(taskId, verifierA);
        _reveal(taskId, verifierB);

        // A Consensus outcome pays the full bounty or it does not settle: the
        // keeper picks the classification, never the amount.
        if (rewardBps != 10_000) {
            vm.prank(keeper);
            vm.expectRevert(ProofRelay.InvalidRewardBps.selector);
            relay.finalizeConsensus(taskId, keccak256("r"), 1, _both(), rewardBps);
            rewardBps = 10_000;
        }

        vm.prank(keeper);
        relay.finalizeConsensus(taskId, keccak256("r"), 1, _both(), rewardBps);

        uint256 share = (bounty * rewardBps / 10_000) / 2;
        assertEq(relay.allocationOf(taskId, verifierA), share, "A share");
        assertEq(relay.allocationOf(taskId, verifierB), share, "B share");
        assertEq(_allocatedOn(taskId), bounty, "nothing created or destroyed");
        assertEq(address(relay).balance, relay.totalLiabilities(), "solvent");
    }

    function testFuzz_ConflictPayoutIsConserved(uint256 seed) public {
        uint256 bounty = _bound(seed, MIN_BOUNTY, MAX_BOUNTY);
        _fund(bounty);

        bytes32 taskId = _createTask(bounty, 2);
        _commit(taskId, verifierA);
        _commit(taskId, verifierB);
        _reveal(taskId, verifierA);
        _reveal(taskId, verifierB);

        vm.prank(keeper);
        relay.finalizeConsensus(taskId, keccak256("r"), 2, _none(), 0);

        (uint16 conflictRateBps,,,,,,,,,) = relay.params();
        uint256 share = (bounty * conflictRateBps / 10_000) / 2;

        assertEq(relay.allocationOf(taskId, verifierA), share, "A conflict rate");
        assertLe(relay.allocationOf(taskId, verifierA), bounty / 2, "conflict pays less than agreement");
        assertEq(_allocatedOn(taskId), bounty, "nothing created or destroyed");
    }

    function testFuzz_DisputeReallocationStaysInsideTheEscrow(uint256 seed, bool upheld) public {
        uint256 bounty = _bound(seed, MIN_BOUNTY, MAX_BOUNTY);
        _fund(bounty);

        bytes32 taskId = _createTask(bounty, 2);
        _commit(taskId, verifierA);
        _commit(taskId, verifierB);
        _reveal(taskId, verifierA);
        _reveal(taskId, verifierB);

        vm.prank(keeper);
        relay.finalizeConsensus(taskId, keccak256("r"), 1, _both(), 10_000);

        uint256 bond = _bond(bounty);
        vm.deal(creator, bond);
        vm.prank(creator);
        relay.openChallenge{value: bond}(taskId, keccak256("e"), "0g://e");

        vm.prank(adjudicator);
        relay.resolveDispute(taskId, upheld, keccak256("a"), "0g://a", _one(verifierB), keccak256("why"));

        assertEq(_allocatedOn(taskId), bounty + bond, "adjudication conserved the pool");
        assertEq(address(relay).balance, relay.totalLiabilities(), "solvent");
    }

    function testFuzz_ExpiryPayoutIsConserved(uint256 seed, bool anyoneRevealed) public {
        uint256 bounty = _bound(seed, MIN_BOUNTY, MAX_BOUNTY);
        _fund(bounty);

        bytes32 taskId = _createTask(bounty, 2);
        _commit(taskId, verifierA);
        _commit(taskId, verifierB);
        if (anyoneRevealed) {
            _reveal(taskId, verifierA);
        }

        (,,,,,,, uint32 keeperGracePeriod,,) = relay.params();
        vm.warp(uint256(relay.getTask(taskId).revealDeadline) + keeperGracePeriod + 1);
        relay.expireTask(taskId);

        assertEq(_allocatedOn(taskId), bounty, "expiry conserved the bounty");
        assertEq(relay.allocationOf(taskId, verifierB), 0, "silent verifier earns nothing");
    }

    /// A commitment made by one verifier can never be opened by another.
    function testFuzz_CommitmentBindsToTheVerifier(
        bytes32 taskId,
        address left,
        address right,
        bytes32 reportHash,
        bytes32 salt
    ) public view {
        vm.assume(left != right);

        assertTrue(
            relay.computeCommitment(taskId, left, reportHash, salt)
                != relay.computeCommitment(taskId, right, reportHash, salt),
            "commitment must bind to the revealer"
        );
    }

    function testFuzz_CommitmentBindsToTheReport(bytes32 taskId, address verifier, bytes32 a, bytes32 b) public view {
        vm.assume(a != b);

        assertTrue(
            relay.computeCommitment(taskId, verifier, a, bytes32(0))
                != relay.computeCommitment(taskId, verifier, b, bytes32(0)),
            "commitment must bind to the report hash"
        );
    }

    function testFuzz_TaskIdIsUniquePerCreatorAndNonce(address left, address right, uint256 nonce) public view {
        vm.assume(left != right);
        vm.assume(nonce < type(uint256).max);

        bytes32 a = keccak256(abi.encode(block.chainid, address(relay), left, nonce));
        bytes32 b = keccak256(abi.encode(block.chainid, address(relay), right, nonce));
        bytes32 next = keccak256(abi.encode(block.chainid, address(relay), left, nonce + 1));

        assertTrue(a != b, "different creators collide");
        assertTrue(a != next, "consecutive nonces collide");
    }

    function testFuzz_BondScalesWithTheBountyAndMustBeExact(uint256 seed, uint256 offsetSeed) public {
        uint256 bounty = _bound(seed, MIN_BOUNTY, MAX_BOUNTY);
        _fund(bounty);

        bytes32 taskId = _createTask(bounty, 2);
        _commit(taskId, verifierA);
        _commit(taskId, verifierB);
        _reveal(taskId, verifierA);
        _reveal(taskId, verifierB);

        vm.prank(keeper);
        relay.finalizeConsensus(taskId, keccak256("r"), 1, _both(), 10_000);

        (, uint16 challengeBondBps,,,,,,,,) = relay.params();
        uint256 bond = bounty * challengeBondBps / 10_000;
        uint256 wrong = _bound(offsetSeed, 1, bond == 0 ? 1 : bond);

        vm.deal(creator, bond + wrong);
        vm.prank(creator);
        vm.expectRevert(ProofRelay.InsufficientBond.selector);
        relay.openChallenge{value: bond - wrong}(taskId, keccak256("e"), "0g://e");

        vm.prank(creator);
        relay.openChallenge{value: bond}(taskId, keccak256("e"), "0g://e");
        assertEq(relay.getDispute(taskId).bond, bond, "bond scales with the bounty");
    }

    function testFuzz_StakeIsFullyRefundable(uint256 seed) public {
        uint256 stake = _bound(seed, 1, 1_000 ether);
        vm.deal(verifierC, stake);

        vm.prank(verifierC);
        relay.registerVerifier{value: stake}(keccak256("m"), "0g://m");
        vm.prank(verifierC);
        relay.withdrawStake(stake);
        vm.prank(verifierC);
        relay.withdraw();

        assertEq(verifierC.balance, stake, "stake returned in full");
        assertEq(relay.totalLiabilities(), 0, "no residual liability");
    }
}
