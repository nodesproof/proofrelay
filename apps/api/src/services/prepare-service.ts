/**
 * `POST /v1/tasks/prepare` and `POST /v1/tasks/{taskId}/challenge`.
 *
 * Preparation is everything that has to happen *before* a wallet signs: screen
 * the input, snapshot the sources, anchor them in 0G Storage, and hand back the
 * exact tuple `createTask` takes plus the id that call will mint. The API never
 * signs for the creator — it prepares artifacts and returns arguments, which is
 * why nothing here touches a private key.
 *
 * Two properties this file is responsible for:
 *
 * - **A dead source does not fail preparation.** The snapshot carries
 *   `SOURCE_UNAVAILABLE` and the task is still creatable, because the honest
 *   record of "we tried this URL and it was down" is itself evidence.
 * - **The hash travels with the pointer.** A `0g://0x…` pointer names a merkle
 *   root, not the object hash; the keccak over canonical bytes is the only
 *   integrity mechanism, so it is what goes into `createTaskArgs`.
 */
import { randomUUID } from "node:crypto";
import type { Address, Hex } from "viem";
import type { Config } from "@proofrelay/config";
import type { StorageAdapter, StoredObject } from "@proofrelay/storage-adapter";
import {
  computeTaskId,
  type ChainClient,
  type ProtocolParams,
  type ReportOnChain,
  type TaskOnChain,
} from "@proofrelay/chain-client";
import {
  ChallengeEvidence,
  DEFAULT_RULE,
  PrepareChallengeRequest,
  PrepareChallengeResponse,
  PrepareTaskRequest,
  PrepareTaskResponse,
  ProofRelayError,
  SCHEMA_VERSION,
  TaskManifest,
  TaskStatus,
  type ManifestSource,
  type SourceSnapshot,
} from "@proofrelay/schemas";
import { fetchSources as defaultFetchSources, type FetchOptions, type SourceInput } from "../fetcher/source-fetcher.js";
import {
  screenForPersonalData,
  type PersonalDataKind,
  type PersonalDataScreen,
} from "../fetcher/safety.js";
import type { Logger } from "../observability.js";

/* ── context ─────────────────────────────────────────────────────────────── */

export interface PrepareChainReader {
  readonly chainId: number;
  readonly contract: Address;
  creatorNonce(creator: Address): Promise<bigint>;
  params(): Promise<ProtocolParams>;
  getTask(taskId: Hex): Promise<TaskOnChain>;
  getTaskVerifiers(taskId: Hex): Promise<readonly Address[]>;
  getReport(taskId: Hex, verifier: Address): Promise<ReportOnChain>;
}

/** Same compile-time proof as in `task-service.ts`, for the same reason. */
type Assert<T extends true> = T;
export type ChainClientIsPrepareChainReader = Assert<
  ChainClient extends PrepareChainReader ? true : false
>;

export interface PrepareServiceContext {
  chain: PrepareChainReader;
  storage: StorageAdapter;
  config: Config;
  logger?: Logger | undefined;
  now?: (() => Date) | undefined;
  /** Manifest id generator; a uuid in production, pinned in tests. */
  newId?: (() => string) | undefined;
  /** The SSRF-safe fetcher, injectable so a suite never dials a real host. */
  fetchSources?: typeof defaultFetchSources;
  /** Merged over the limits `loadConfig()` produced — a test resolver goes here. */
  fetchOptions?: FetchOptions | undefined;
}

/* ── constants ───────────────────────────────────────────────────────────── */

/** What the live manifests record, and what the verifier profiles are tuned to. */
const MAX_EVIDENCE_PER_CLAIM = 3;

/** `MAX_POINTER_BYTES()` on the deployed contract; a longer pointer reverts. */
const MAX_POINTER_BYTES = 256;

const BPS_DENOMINATOR = 10_000n;

function sourceId(index: number): string {
  return `src-${String(index + 1).padStart(3, "0")}`;
}

function claimId(index: number): string {
  return `claim-${String(index + 1).padStart(3, "0")}`;
}

/* ── validation ──────────────────────────────────────────────────────────── */

function parseOrThrow<T>(schema: { parse(value: unknown): T }, value: unknown, what: string): T {
  try {
    return schema.parse(value);
  } catch (error) {
    const issues = (error as { issues?: { path: (string | number)[]; message: string }[] }).issues;
    throw new ProofRelayError("VALIDATION_FAILED", `${what} is not valid`, {
      cause: error,
      detail: {
        issues:
          issues?.map((issue) => ({ path: issue.path.join("."), message: issue.message })) ??
          [{ path: "", message: String((error as Error)?.message ?? error) }],
      },
    });
  }
}

/**
 * A rejection names the offending field and the kind of match, never the match
 * itself. Echoing it back would make the error response the second copy of the
 * value the creator was trying not to publish.
 */
function rejectPersonalData(screen: PersonalDataScreen): never {
  throw new ProofRelayError(
    "PERSONAL_DATA_REJECTED",
    "the request contains personal data and cannot become a public artifact",
    {
      detail: {
        matches: screen.matches.map((match) => ({ field: match.field, kind: match.kind })),
        fields: [...new Set(screen.matches.map((match) => match.field))],
      },
    },
  );
}

/**
 * Kinds whose permanent republication is itself the injury.
 *
 * A fetched page is a third party's already-published document, not something
 * the creator wrote. Refusing every page that carries a contact address would
 * refuse most of the standards web — RFC 9309, which this project uses as a
 * test source, names four addresses in its own acknowledgements. So an address
 * or a phone number is recorded rather than refused. A private key, a card
 * number or a national id is a different thing: copying it into permanent
 * content-addressed storage is the harm, whoever published it first, and no
 * later takedown reaches an object that is addressed by its own hash.
 */
const SNAPSHOT_BLOCKING_KINDS: ReadonlySet<PersonalDataKind> = new Set([
  "private-key",
  "payment-card",
  "national-id",
]);

/** Enough to characterise a page; not a second copy of it. */
const MAX_REDACTION_NOTES = 32;

/**
 * Screens the bytes that were actually fetched, and reports what it found.
 *
 * `screenForPersonalData` ran over the creator's typed fields only, and it ran
 * BEFORE the fetch — so `publicDataOnly: true` and `redactions: []` went into
 * the manifest as literals about bytes no code had read. The asymmetry was the
 * tell: the same document pasted as `inlineText` was screened and could be
 * refused, while the same document named as a URL reached permanent public
 * storage with an assurance attached that nothing had checked. Mainnet task
 * 0x88218974… shipped a snapshot in which this project's own EMAIL detector
 * finds four addresses, under `publicDataOnly: true`.
 *
 * `redactions` carries excerpts in which the match itself is already replaced
 * by a marker, so recording a finding never republishes it.
 */
export function screenSnapshots(snapshots: readonly SourceSnapshot[]): {
  publicDataOnly: boolean;
  redactions: string[];
  warnings: string[];
} {
  const fields: Record<string, string> = {};
  for (const snapshot of snapshots) {
    if (snapshot.text) fields[`${snapshot.sourceId} ${snapshot.uri}`] = snapshot.text;
  }
  const screen = screenForPersonalData(fields);

  const blocking = screen.matches.filter((match) => SNAPSHOT_BLOCKING_KINDS.has(match.kind));
  if (blocking.length > 0) rejectPersonalData({ ok: false, matches: blocking, warnings: screen.warnings });

  const notes: string[] = [];
  for (const match of screen.matches) {
    const note = `${match.kind} in ${match.field}: ${match.excerpt}`;
    if (!notes.includes(note)) notes.push(note);
    if (notes.length >= MAX_REDACTION_NOTES) break;
  }
  // Say so rather than let a truncated list read as the whole finding.
  if (screen.matches.length > notes.length) {
    notes.push(`… and ${screen.matches.length - notes.length} more matches not listed`);
  }

  return {
    publicDataOnly: screen.matches.length === 0,
    redactions: notes,
    warnings: screen.warnings,
  };
}

/* ── sources ─────────────────────────────────────────────────────────────── */

type RequestSource = PrepareTaskRequest["sources"][number];

interface PreparedSourceInput {
  input: SourceInput;
  /** What the personal-data screen looks at for this source. */
  screened: Record<string, string>;
}

function toSourceInput(source: RequestSource, index: number): PreparedSourceInput {
  const id = sourceId(index);
  if (typeof source === "string") {
    return { input: { sourceId: id, uri: source }, screened: { [`sources[${index}].uri`]: source } };
  }
  if ("inlineText" in source) {
    const screened: Record<string, string> = {
      // Pasted text is a creator-supplied input that becomes a public artifact
      // verbatim, which is exactly the case the threat model names — so it is
      // screened like any other field rather than trusted because it was typed.
      [`sources[${index}].inlineText`]: source.inlineText,
    };
    if (source.label) screened[`sources[${index}].label`] = source.label;
    return {
      input: { sourceId: id, inlineText: source.inlineText, uri: source.label },
      screened,
    };
  }
  return { input: { sourceId: id, uri: source.uri }, screened: { [`sources[${index}].uri`]: source.uri } };
}

async function uploadSnapshot(
  ctx: PrepareServiceContext,
  snapshot: SourceSnapshot,
): Promise<StoredObject> {
  try {
    return await ctx.storage.put("source-snapshot", snapshot);
  } catch (error) {
    throw new ProofRelayError("STORAGE_UPLOAD_FAILED", `could not store snapshot ${snapshot.sourceId}`, {
      cause: error,
      detail: { sourceId: snapshot.sourceId, driver: ctx.storage.driver },
    });
  }
}

function warnAboutSnapshot(snapshot: SourceSnapshot): string | null {
  switch (snapshot.status) {
    case "OK":
      return null;
    case "TRUNCATED":
      return `source ${snapshot.sourceId} was truncated at ${snapshot.byteLength} bytes`;
    default:
      return `source ${snapshot.sourceId} (${snapshot.uri}) is ${snapshot.status}: ${
        snapshot.error ?? "no detail"
      }`;
  }
}

/* ── prepare a task ──────────────────────────────────────────────────────── */

export interface PrepareTaskArgs {
  /** The authenticated wallet. The manifest and the predicted id both bind to it. */
  creator: Address;
  request: unknown;
}

export async function prepareTask(
  ctx: PrepareServiceContext,
  args: PrepareTaskArgs,
): Promise<PrepareTaskResponse> {
  const now = ctx.now?.() ?? new Date();
  const request = parseOrThrow(PrepareTaskRequest, args.request, "the task specification");
  const creator = args.creator.toLowerCase() as Address;

  const prepared = request.sources.map(toSourceInput);

  const screened: Record<string, string> = {
    title: request.title,
    question: request.question,
  };
  if (request.answerText) screened.answerText = request.answerText;
  request.claims.forEach((claim, index) => {
    screened[`claims[${index}]`] = claim;
  });
  for (const entry of prepared) Object.assign(screened, entry.screened);

  const screen = screenForPersonalData(screened);
  if (!screen.ok) rejectPersonalData(screen);

  // Checked before anything is fetched or uploaded: a bounty the contract will
  // refuse makes every byte of the rest of this call wasted work.
  const params = await ctx.chain.params();
  if (BigInt(request.bountyWei) < params.minBounty) {
    throw new ProofRelayError("VALIDATION_FAILED", "the bounty is below the protocol minimum", {
      detail: { bountyWei: request.bountyWei, minBountyWei: params.minBounty.toString() },
    });
  }

  const fetchAll = ctx.fetchSources ?? defaultFetchSources;
  const snapshots = await fetchAll(
    prepared.map((entry) => entry.input),
    {
      producer: ctx.config.api.producerId,
      maxBytes: ctx.config.fetch.maxBytes,
      timeoutMs: ctx.config.fetch.timeoutMs,
      maxRedirects: ctx.config.fetch.maxRedirects,
      allowPrivate: ctx.config.fetch.allowPrivate,
      now: () => now,
      ...(ctx.fetchOptions ?? {}),
    },
  );

  // Before a byte of this reaches permanent storage: the creator named these
  // URLs, they did not write what is behind them.
  const fetched = screenSnapshots(snapshots);

  const warnings = [...screen.warnings, ...fetched.warnings];
  const manifestSources: ManifestSource[] = [];
  const responseSources: PrepareTaskResponse["sources"] = [];

  for (const snapshot of snapshots) {
    const stored = await uploadSnapshot(ctx, snapshot);
    const source: ManifestSource = {
      sourceId: snapshot.sourceId,
      uri: snapshot.uri,
      status: snapshot.status,
      contentHash: snapshot.contentHash,
      byteLength: snapshot.byteLength,
      snapshotHash: stored.hash,
      snapshotPointer: stored.pointer,
    };
    manifestSources.push(source);
    responseSources.push({ ...source, error: snapshot.error });

    const warning = warnAboutSnapshot(snapshot);
    if (warning) {
      warnings.push(warning);
      ctx.logger?.warn("source snapshot is not OK", {
        errorCode: snapshot.status === "REJECTED" ? "SOURCE_BLOCKED" : "SOURCE_UNAVAILABLE",
        sourceId: snapshot.sourceId,
        uri: snapshot.uri,
      });
    }
  }

  const ruleId = DEFAULT_RULE.ruleId;
  const manifest: TaskManifest = parseOrThrow(
    TaskManifest,
    {
      kind: "task-manifest",
      schemaVersion: SCHEMA_VERSION,
      producer: ctx.config.api.producerId,
      manifestId: ctx.newId?.() ?? randomUUID(),
      chainId: ctx.config.chain.chainId,
      creator,
      title: request.title,
      question: request.question,
      answerText: request.answerText ?? null,
      claims: request.claims.map((claimText, index) => ({
        claimId: claimId(index),
        claimText,
        origin: "creator" as const,
      })),
      sources: manifestSources,
      // Claims came from the creator, so no extraction ran. A model that never
      // executed must not be credited with the claim list.
      extraction: null,
      policy: {
        verifierCount: request.verifierCount,
        commitWindowSec: request.commitWindowSec,
        revealWindowSec: request.revealWindowSec,
        disputeWindowSec: request.disputeWindowSec,
        maxEvidencePerClaim: MAX_EVIDENCE_PER_CLAIM,
        ruleId,
      },
      safety: {
        publicDataOnly: fetched.publicDataOnly,
        redactions: fetched.redactions,
        warnings,
      },
      createdAt: now.toISOString(),
    },
    "the assembled manifest",
  );

  let stored: StoredObject;
  try {
    stored = await ctx.storage.put("task-manifest", manifest);
  } catch (error) {
    throw new ProofRelayError("STORAGE_UPLOAD_FAILED", "could not store the task manifest", {
      cause: error,
      detail: { driver: ctx.storage.driver },
    });
  }

  if (Buffer.byteLength(stored.pointer, "utf8") > MAX_POINTER_BYTES) {
    throw new ProofRelayError("VALIDATION_FAILED", "the manifest pointer is longer than the contract accepts", {
      detail: { pointer: stored.pointer, maxBytes: MAX_POINTER_BYTES },
    });
  }

  // Advisory: the id the contract will mint for the creator's *next* task. A
  // second createTask signed between here and the wallet prompt consumes the
  // nonce, so the UI reconciles against the TaskCreated log rather than this.
  const predictedTaskId = computeTaskId({
    chainId: ctx.config.chain.chainId,
    contract: ctx.chain.contract,
    creator,
    nonce: await ctx.chain.creatorNonce(creator),
  });

  ctx.logger?.info("task prepared", {
    taskId: predictedTaskId,
    manifestHash: stored.hash,
    sources: manifestSources.length,
    warnings: warnings.length,
  });

  return parseOrThrow(
    PrepareTaskResponse,
    {
      manifestId: manifest.manifestId,
      manifestHash: stored.hash,
      manifestPointer: stored.pointer,
      manifest,
      ruleId,
      predictedTaskId,
      sources: responseSources,
      warnings,
      createTaskArgs: {
        verifierCount: request.verifierCount,
        commitWindowSec: request.commitWindowSec,
        revealWindowSec: request.revealWindowSec,
        disputeWindowSec: request.disputeWindowSec,
        manifestHash: stored.hash,
        manifestPointer: stored.pointer,
        ruleId,
        valueWei: request.bountyWei,
      },
    },
    "the prepared task response",
  );
}

/* ── prepare a challenge ─────────────────────────────────────────────────── */

export interface PrepareChallengeArgs {
  taskId: string;
  challenger: Address;
  request: unknown;
  /** Revealed report hashes; read from the chain when the caller has none. */
  reportHashes?: string[] | undefined;
}

/** The revealed report hashes a challenge disputes, straight from the chain. */
async function revealedReportHashes(ctx: PrepareServiceContext, taskId: Hex): Promise<string[]> {
  const verifiers = await ctx.chain.getTaskVerifiers(taskId).catch(() => [] as readonly Address[]);
  const reports = await Promise.all(
    verifiers.map((verifier) => ctx.chain.getReport(taskId, verifier).catch(() => null)),
  );
  return reports
    .filter((report): report is ReportOnChain => Boolean(report?.revealed))
    .map((report) => report.reportHash)
    .filter((hash) => !/^0x0{64}$/i.test(hash));
}

export async function prepareChallenge(
  ctx: PrepareServiceContext,
  args: PrepareChallengeArgs,
): Promise<PrepareChallengeResponse> {
  const now = ctx.now?.() ?? new Date();
  const request = parseOrThrow(PrepareChallengeRequest, args.request, "the challenge");
  const taskId = args.taskId.trim().toLowerCase() as Hex;
  const challenger = args.challenger.toLowerCase() as Address;

  const screened: Record<string, string> = { reason: request.reason };
  request.additionalEvidence.forEach((entry, index) => {
    screened[`additionalEvidence[${index}].uri`] = entry.uri;
    if (entry.note) screened[`additionalEvidence[${index}].note`] = entry.note;
  });
  const screen = screenForPersonalData(screened);
  if (!screen.ok) rejectPersonalData(screen);

  const task = await ctx.chain.getTask(taskId);
  if (task.status === TaskStatus.None) {
    throw new ProofRelayError("TASK_NOT_FOUND", `the chain has no task ${taskId}`, {
      detail: { taskId, contract: ctx.chain.contract },
    });
  }

  const fetchAll = ctx.fetchSources ?? defaultFetchSources;
  const snapshots = await fetchAll(
    request.additionalEvidence.map((entry, index) => ({
      sourceId: `challenge-${sourceId(index)}`,
      uri: entry.uri,
    })),
    {
      producer: ctx.config.api.producerId,
      maxBytes: ctx.config.fetch.maxBytes,
      timeoutMs: ctx.config.fetch.timeoutMs,
      maxRedirects: ctx.config.fetch.maxRedirects,
      allowPrivate: ctx.config.fetch.allowPrivate,
      now: () => now,
      ...(ctx.fetchOptions ?? {}),
    },
  );

  // Challenge evidence is published exactly as task sources are, so it gets the
  // same screen. ChallengeEvidence has no `safety` block to record a finding in,
  // so what is not blocking is logged for the operator rather than dropped.
  const fetchedScreen = screenSnapshots(snapshots);
  if (!fetchedScreen.publicDataOnly) {
    ctx.logger?.warn("challenge evidence carries personal data", {
      taskId,
      challenger,
      redactions: fetchedScreen.redactions.length,
    });
  }

  // The artifact records a content hash per evidence URL, so the bytes it
  // addresses have to exist somewhere: each snapshot is stored before its hash
  // is quoted, including the ones that came back empty because the host was down.
  const additionalEvidence: ChallengeEvidence["additionalEvidence"] = [];
  for (const [index, snapshot] of snapshots.entries()) {
    await uploadSnapshot(ctx, snapshot);
    if (snapshot.status !== "OK" && snapshot.status !== "TRUNCATED") {
      ctx.logger?.warn("challenge evidence source is not OK", {
        taskId,
        errorCode: snapshot.status === "REJECTED" ? "SOURCE_BLOCKED" : "SOURCE_UNAVAILABLE",
        uri: snapshot.uri,
      });
    }
    additionalEvidence.push({
      uri: snapshot.uri,
      contentHash: snapshot.contentHash,
      note: request.additionalEvidence[index]?.note ?? "",
    });
  }

  const evidence: ChallengeEvidence = parseOrThrow(
    ChallengeEvidence,
    {
      kind: "challenge-evidence",
      schemaVersion: SCHEMA_VERSION,
      taskId,
      challenger,
      reason: request.reason,
      disputedClaims: request.disputedClaims,
      disputedReportHashes: args.reportHashes ?? (await revealedReportHashes(ctx, taskId)),
      additionalEvidence,
      createdAt: now.toISOString(),
    },
    "the assembled challenge evidence",
  );

  let stored: StoredObject;
  try {
    stored = await ctx.storage.put("challenge-evidence", evidence);
  } catch (error) {
    throw new ProofRelayError("STORAGE_UPLOAD_FAILED", "could not store the challenge evidence", {
      cause: error,
      detail: { taskId, driver: ctx.storage.driver },
    });
  }

  // `openChallenge` requires msg.value to equal this exactly — the live
  // challenge sent 4e14 against a 4e15 bounty at 1000 bps — so it is computed
  // from the chain's own bounty and bps rather than quoted from a config file.
  const params = await ctx.chain.params();
  const bond = (task.bounty * BigInt(params.challengeBondBps)) / BPS_DENOMINATOR;

  ctx.logger?.info("challenge prepared", {
    taskId,
    evidenceHash: stored.hash,
    bondWei: bond.toString(),
  });

  return parseOrThrow(
    PrepareChallengeResponse,
    {
      evidenceHash: stored.hash,
      evidencePointer: stored.pointer,
      bondWei: bond.toString(),
      evidence,
    },
    "the prepared challenge response",
  );
}

/* ── facade ──────────────────────────────────────────────────────────────── */

export function createPrepareService(ctx: PrepareServiceContext) {
  return {
    prepareTask: (args: PrepareTaskArgs) => prepareTask(ctx, args),
    prepareChallenge: (args: PrepareChallengeArgs) => prepareChallenge(ctx, args),
  };
}

export type PrepareService = ReturnType<typeof createPrepareService>;
