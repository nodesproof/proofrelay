#!/usr/bin/env node
/**
 * Spreads gas from the funded operator to the role wallets.
 *
 * The faucet drips per address, so funding the roles directly would take a day
 * each. Only the operator needs the faucet; this tops the rest up to a floor,
 * and skips any address that is already above it.
 */
import { createPublicClient, createWalletClient, formatEther, http, parseEther, parseGwei } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { galileo, MIN_PRIORITY_FEE, networkInfo } from "@proofrelay/chain-client";
import { loadConfig, env } from "@proofrelay/config";

const config = loadConfig();
const chain = { ...galileo, id: config.chain.chainId };
const transport = http(config.chain.rpcUrl);
const publicClient = createPublicClient({ chain, transport });

const operator = privateKeyToAccount(env("PRIVATE_KEY"));
const wallet = createWalletClient({ account: operator, chain, transport });

/**
 * Floors, not transfers: each address is topped up TO this figure, so re-running
 * is idempotent and an address that is already above its floor is skipped.
 *
 * The defaults size a testnet demo and fit inside one 0.1 0G faucet drip. They
 * are per-address env-overridable because the right number is a function of how
 * many tasks the deployment expects to run, and on mainnet that is not a
 * question this file can answer — measured at 4 gwei, which is what both
 * networks settle at:
 *
 *   keeper       0.00078 per task        FUND_KEEPER
 *   adjudicator  0.0007 per dispute      FUND_ADJUDICATOR
 *   verifier     0.0014 per task         FUND_VERIFIER_A … FUND_VERIFIER_D
 *   creator      0.001 per task + bounty FUND_CREATOR
 *   storage      0.001182 per object,    FUND_STORAGE
 *                up to 21 per prepare
 */
const target = (name, fallback) => parseEther(env(name) ?? fallback);

const TARGETS = [
  ["KEEPER_ADDRESS", target("FUND_KEEPER", "0.005")],
  ["ADJUDICATOR_ADDRESS", target("FUND_ADJUDICATOR", "0.005")],
  ["VERIFIER_A_ADDRESS", target("FUND_VERIFIER_A", "0.01")],
  ["VERIFIER_B_ADDRESS", target("FUND_VERIFIER_B", "0.01")],
  ["VERIFIER_C_ADDRESS", target("FUND_VERIFIER_C", "0.01")],
  ["VERIFIER_D_ADDRESS", target("FUND_VERIFIER_D", "0.01")],
  ["CREATOR_ADDRESS", target("FUND_CREATOR", "0.02")],
  // Higher than the rest on purpose: this key pays a fee per stored object on
  // top of gas, and one accepted prepare writes up to 21 of them.
  ["STORAGE_ADDRESS", target("FUND_STORAGE", "0.05")],
];

// The operator pays for the transfers themselves and stays the deploy/admin key,
// so spending it down to the last wei strands the deployment. Refuse early and
// name the figure rather than failing on the last transfer.
const REQUIRED = TARGETS.reduce((sum, [, floor]) => sum + floor, 0n) + parseEther(env("FUND_RESERVE") ?? "0.03");

/**
 * Both 0G networks report a block before the receipts for its transactions are
 * queryable. Waiting once and giving up abandons a transfer that in fact
 * succeeded — which it did, leaving the run looking failed while every wallet
 * was funded. `ChainClient.waitForReceipt` handles this for contract calls;
 * plain transfers need the same patience.
 */
async function waitForReceipt(hash, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      return await publicClient.waitForTransactionReceipt({ hash, timeout: 20_000, pollingInterval: 1_000 });
    } catch (error) {
      last = error;
      if (!/could not be found|not be processed|receipt.*not found|no matching receipts/i.test(String(error))) throw error;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }
  throw last;
}

const balance = await publicClient.getBalance({ address: operator.address });
console.log(`operator ${operator.address}  ${formatEther(balance)} 0G`);
if (balance === 0n) {
  // A network with no faucet is a network where "go and top up for free" is
  // wrong advice, so the message names the address to send real 0G to instead.
  const faucet = networkInfo(config.chain.chainId).faucet;
  console.error(
    faucet
      ? `\nThe operator has no balance. Fund it at ${faucet} first.`
      : `\nThe operator has no balance and ${networkInfo(config.chain.chainId).name} has no faucet.` +
        `\nSend 0G to ${operator.address} before running this again.`,
  );
  process.exit(1);
}

if (balance < REQUIRED) {
  console.log(
    `\nwarning: the targets below total ${formatEther(REQUIRED)} 0G including the operator's own\n` +
      `reserve, and the operator holds ${formatEther(balance)} 0G. Later transfers will fail.\n` +
      `Raise the balance, or lower the floors with FUND_KEEPER / FUND_STORAGE / … .\n`,
  );
}

const tip = await publicClient.estimateMaxPriorityFeePerGas().catch(() => 0n);
const priority = tip > MIN_PRIORITY_FEE ? tip : MIN_PRIORITY_FEE;
const block = await publicClient.getBlock({ blockTag: "latest" });
const fees = { maxPriorityFeePerGas: priority, maxFeePerGas: (block.baseFeePerGas ?? 0n) * 2n + priority };

for (const [name, floor] of TARGETS) {
  const to = env(name);
  if (!to) {
    console.log(`  – ${name} is not set; run \`npm run wallets\` first`);
    continue;
  }
  const current = await publicClient.getBalance({ address: to });
  if (current >= floor) {
    console.log(`  = ${name.padEnd(22)} ${to}  ${formatEther(current)} 0G`);
    continue;
  }
  const value = floor - current;
  const hash = await wallet.sendTransaction({ to, value, ...fees });
  await waitForReceipt(hash);
  console.log(`  + ${name.padEnd(22)} ${to}  +${formatEther(value)} 0G  ${hash}`);
}

console.log(`\noperator left with ${formatEther(await publicClient.getBalance({ address: operator.address }))} 0G`);
