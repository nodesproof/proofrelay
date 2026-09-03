import { formatEther } from "viem";
import { ChainClient, txUrl } from "@proofrelay/chain-client";
import { loadConfig, verifierProfile } from "@proofrelay/config";
const config = loadConfig();
for (const p of ["a", "b"]) {
  const profile = verifierProfile(p);
  const chain = new ChainClient({
    chainId: config.chain.chainId, rpcUrl: config.chain.rpcUrl,
    contract: config.chain.contract, privateKey: profile.privateKey, confirmations: 1,
  });
  const pending = await chain.pendingWithdrawals(chain.account);
  if (pending === 0n) { console.log(`${profile.id} ${chain.account} nothing pending`); continue; }
  const before = await chain.balanceOf(chain.account);
  const r = await chain.send("withdraw", []);
  const after = await chain.balanceOf(chain.account);
  console.log(`${profile.id} ${chain.account}`);
  console.log(`  withdrew ${formatEther(pending)} 0G   ${txUrl(config.chain.chainId, r.txHash)}`);
  console.log(`  balance  ${formatEther(before)} -> ${formatEther(after)} 0G`);
}
