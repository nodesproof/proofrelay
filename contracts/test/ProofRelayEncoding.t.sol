// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ProofRelay} from "../src/ProofRelay.sol";
import {ProofRelayFixture} from "./Base.t.sol";

/**
 * The two encodings that must never drift, pinned against the contract at
 * 0xc1E353cb44eA09729143f06Af97E51FB952b33D7 on 0G Galileo rather than against
 * ourselves. The fixtures below are real: the task id is the one in the
 * TaskCreated log of that deployment's first task, and the commitment is the
 * one in its ReportCommitted log, checked against the report hash and salt that
 * the matching revealReport transaction actually carried.
 *
 * The same fixtures are asserted from the TypeScript side in
 * packages/chain-client/src/encoding.test.ts. If these two ever disagree, a
 * verifier that already uploaded its report would be unable to reveal it.
 */
contract ProofRelayEncodingTest is ProofRelayFixture {
    address internal constant LIVE_CONTRACT = 0xc1E353cb44eA09729143f06Af97E51FB952b33D7;
    address internal constant LIVE_CREATOR = 0x33D2b4aA407b450aFF307F81fEC812FF6CD26266;
    address internal constant LIVE_VERIFIER = 0xeFf4313AD00b3aD7f3Be18c75Bc862CaA3d1e8FA;
    uint256 internal constant GALILEO = 16602;

    bytes32 internal constant LIVE_TASK_ID = 0xf5b3b3ea97fc38ce0520df37f52c5326f09b132af610e65ed39b14523f3b2db2;
    bytes32 internal constant LIVE_REPORT_HASH = 0xc2d7daa2cc4556b6a52c5b08a04fccdc3273a417235037dbc85c5d12f3b86e23;
    bytes32 internal constant LIVE_SALT = 0x8b16d8f7abc4539dd3239843a5de1d0183cea4e1294dccfd55f7ea4e96214d17;
    bytes32 internal constant LIVE_COMMITMENT = 0x871adcee4a7d0f4ec8ffbb6f4e0c01322cc58facfaa6a6ee45ddd4a9e63c4aba;

    /**
     * Runs this contract's own createTask at the live address, on the live
     * chain id, as the live creator with a fresh nonce — so the id it returns
     * has to be the one the chain already recorded.
     */
    function test_TaskIdReproducesTheFirstLiveTask() public {
        vm.chainId(GALILEO);
        ProofRelay template = new ProofRelay(admin, keeper, adjudicator);
        vm.etch(LIVE_CONTRACT, address(template).code);

        vm.deal(LIVE_CREATOR, 10 ether);
        vm.prank(LIVE_CREATOR);
        bytes32 taskId = ProofRelay(LIVE_CONTRACT).createTask{value: 0.002 ether}(_spec(2));

        assertEq(taskId, LIVE_TASK_ID, "taskId encoding drifted from the deployed contract");
    }

    function test_TaskIdFormulaMatchesTheClient() public view {
        assertEq(
            keccak256(abi.encode(GALILEO, LIVE_CONTRACT, LIVE_CREATOR, uint256(0))),
            LIVE_TASK_ID,
            "keccak256(chainId, contract, creator, nonce)"
        );
    }

    function test_CommitmentReproducesALiveCommitment() public view {
        assertEq(
            relay.computeCommitment(LIVE_TASK_ID, LIVE_VERIFIER, LIVE_REPORT_HASH, LIVE_SALT),
            LIVE_COMMITMENT,
            "commitment encoding drifted from the deployed contract"
        );
    }

    function test_CommitmentIsIndependentOfTheContractInstance() public {
        ProofRelay other = new ProofRelay(admin, keeper, adjudicator);
        assertEq(
            other.computeCommitment(LIVE_TASK_ID, LIVE_VERIFIER, LIVE_REPORT_HASH, LIVE_SALT),
            LIVE_COMMITMENT,
            "commitment must not depend on address(this)"
        );
    }
}
