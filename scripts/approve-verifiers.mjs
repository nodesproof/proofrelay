#!/usr/bin/env node
/**
 * The MVP's sybil defence is an admin allow-list: a verifier must self-register
 * AND be approved before commitReport will accept it. This grants the keeper and
 * adjudicator roles too, so one command leaves a fresh deployment operable.
 */
import { ChainClient, ROLE } from "@proofrelay/chain-client";
import { assertContractConfigured, describeConfig, env, loadConfig } from "@proofrelay/config";

const config = loadConfig();
assertContractConfigured(config);
console.log(describeConfig(config), "\n");

const admin = env("PRIVATE_KEY");
if (!admin) {
  console.error("PRIVATE_KEY is not set — run `npm run wallets`");
  process.exit(1);
}

const chain = new ChainClient({
  chainId: config.chain.chainId,
  rpcUrl: config.chain.rpcUrl,
  contract: config.chain.contract,
  privateKey: admin,
  confirmations: 1,
});

if (!(await chain.hasRole(ROLE.ADMIN, chain.account))) {
  console.error(`${chain.account} does not hold DEFAULT_ADMIN_ROLE on ${config.chain.contract}`);
  process.exit(1);
}

for (const [name, role] of [
  ["KEEPER_ADDRESS", ROLE.KEEPER],
  ["ADJUDICATOR_ADDRESS", ROLE.ADJUDICATOR],
]) {
  const address = env(name);
  if (!address) continue;
  if (await chain.hasRole(role, address)) {
    console.log(`  = ${name.padEnd(20)} ${address} already holds the role`);
    continue;
  }
  const receipt = await chain.send("grantRole", [role, address]);
  console.log(`  + ${name.padEnd(20)} ${address} granted  ${receipt.txHash}`);
}

for (const name of [
  "VERIFIER_A_ADDRESS",
  "VERIFIER_B_ADDRESS",
  "VERIFIER_C_ADDRESS",
  "VERIFIER_D_ADDRESS",
  ...(env("VERIFIER_ADDRESS") ? ["VERIFIER_ADDRESS"] : []),
]) {
  const address = env(name);
  if (!address) continue;
  const record = await chain.getVerifier(address);
  if (!record.registered) {
    // Approval before registration is allowed by the contract, but the worker
    // still has to register itself before it can commit, so say so.
    console.log(`  ! ${name.padEnd(20)} ${address} has not registered yet; start the worker once`);
  }
  if (record.approved) {
    console.log(`  = ${name.padEnd(20)} ${address} already approved`);
    continue;
  }
  const receipt = await chain.send("setVerifierApproval", [address, true]);
  console.log(`  + ${name.padEnd(20)} ${address} approved  ${receipt.txHash}`);
}
