import type { ComputeConfig } from "@proofrelay/config";
import { LocalComputeAdapter } from "./local.js";
import { LlmComputeAdapter } from "./llm.js";
import { ZeroGBrokerAdapter } from "./broker.js";
import type { ComputeAdapter } from "./types.js";

export * from "./types.js";
export * from "./entailment.js";
export { LocalComputeAdapter, PIPELINE_VERSION, scoreClaim } from "./local.js";
export { LlmComputeAdapter } from "./llm.js";
export { ZeroGBrokerAdapter } from "./broker.js";
export type { BrokerSdk, ZeroGBrokerOptions } from "./broker.js";

export interface CreateComputeOptions {
  evidenceDepth?: number;
  supportThreshold?: number;
  /** Broker-signed request headers, when COMPUTE_DRIVER=zerog-broker. */
  headers?: () => Promise<Record<string, string>>;
}

/**
 * Chosen by configuration, never by probing. A demo that silently fell back
 * from 0G Compute to the offline engine would still look healthy while proving
 * nothing about 0G — and PRD FR-08 is specifically about proving 0G ran.
 * A per-request fallback still exists inside the LLM driver, but it is recorded
 * in the trace rather than hidden.
 */
export function createComputeAdapter(
  config: ComputeConfig,
  options: CreateComputeOptions = {},
): ComputeAdapter {
  const evidenceDepth = options.evidenceDepth ?? 2;
  const supportThreshold = options.supportThreshold ?? 0.55;

  if (config.driver === "local") {
    return new LocalComputeAdapter({ evidenceDepth, supportThreshold });
  }

  if (config.driver === "zerog-router" || config.driver === "openai-compatible") {
    if (!config.apiKey) {
      throw new Error(
        `COMPUTE_DRIVER=${config.driver} needs COMPUTE_API_KEY. ` +
          "Create one at https://pc.testnet.0g.ai for Galileo (16602) or https://pc.0g.ai for mainnet — " +
          "the two networks have separate keys, balances and model catalogs. " +
          "Set COMPUTE_DRIVER=local to run the deterministic engine instead.",
      );
    }
    return new LlmComputeAdapter({
      driver: config.driver,
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      model: config.model,
      timeoutMs: config.timeoutMs,
      maxAttempts: config.maxAttempts,
      evidenceDepth,
      supportThreshold,
      seed: config.seed,
      verifyTee: config.verifyTee,
      trustMode: config.trustMode,
      requireParameters: config.requireParameters,
      providerAddress: config.providerAddress,
    });
  }

  if (config.driver === "zerog-broker") {
    // Needs a key because the key IS the credential: the SDK signs billing
    // headers with it, and the provider redeems those as its settlement proof.
    // Refusing here rather than later keeps a process from starting healthy and
    // failing on the first claim it is asked to score.
    if (!config.privateKey) {
      throw new Error(
        "COMPUTE_DRIVER=zerog-broker needs COMPUTE_PRIVATE_KEY. The broker pays for inference from " +
          "an on-chain ledger funded by that key, which is what lets it run without an API key. " +
          "Set COMPUTE_DRIVER=zerog-router to use an sk- credential instead.",
      );
    }
    return new ZeroGBrokerAdapter({
      privateKey: config.privateKey,
      rpcUrl: config.rpcUrl,
      model: config.model,
      providerAddress: config.providerAddress,
      evidenceDepth,
      supportThreshold,
      timeoutMs: config.timeoutMs,
      maxAttempts: config.maxAttempts,
      seed: config.seed,
      verifyTee: config.verifyTee,
      requireParameters: config.requireParameters,
    });
  }

  throw new Error(`unknown COMPUTE_DRIVER ${config.driver}`);
}
