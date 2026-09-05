/**
 * The typed HTTP client for apps/api.
 *
 * One function per endpoint, every response typed against lib/types.ts. On a
 * non-2xx the server's {error:{code,message,detail}} envelope is rethrown as an
 * ApiError so the UI can render the real code — the API's error codes exist to
 * be shown (FRONTEND_DATA_CONTRACT §6.3), never swallowed into "something went
 * wrong".
 */
import { getAccount } from "wagmi/actions";

import { clearSession, tokenFor } from "./session";
import { wagmiConfig } from "./wagmi";
import type {
  ActivityListResponse,
  Address,
  ApiErrorBody,
  ArtifactListResponse,
  Bytes32,
  ErrorCode,
  HealthResponse,
  NonceResponse,
  PrepareChallengeRequest,
  PrepareChallengeResponse,
  PrepareTaskRequest,
  PrepareTaskResponse,
  ReportFetchResponse,
  SyncResponse,
  TaskDetail,
  TaskListQuery,
  TaskListResponse,
  VerifierListResponse,
  VerifyRequest,
  VerifyResponse,
  WorkspaceStats,
} from "./types";

/**
 * Where the API is, from the browser's point of view. Vite inlines
 * VITE_API_URL at build time.
 *
 * A full origin is right when the page and the API are reached at the same
 * addresses the developer sees. It is wrong the moment the page is served from
 * anywhere else: `http://127.0.0.1:8080` names whatever machine the *visitor*
 * is on, and an https page is not allowed to call http at all. For that case
 * set `VITE_API_URL=/api` and let the page's own server proxy it.
 */
export const API_URL: string = (import.meta.env.VITE_API_URL || "http://127.0.0.1:8080").replace(/\/+$/, "");

/**
 * A failure the UI is expected to render literally: the server's error code,
 * its message, and whatever structured detail came with it.
 */
export class ApiError extends Error {
  readonly code: ErrorCode | string;
  readonly status: number;
  readonly detail: Record<string, unknown> | null;
  readonly url: string;

  constructor(options: { code: ErrorCode | string; message: string; status: number; detail?: Record<string, unknown> | null; url: string }) {
    super(options.message);
    this.name = "ApiError";
    this.code = options.code;
    this.status = options.status;
    this.detail = options.detail ?? null;
    this.url = options.url;
  }

  /** True while the API itself is unreachable, as opposed to refusing the request. */
  get isOffline(): boolean {
    return this.status === 0;
  }

  /** Retrying is only ever meaningful for these; everything else needs a different request. */
  get retryable(): boolean {
    return (
      this.status === 0 ||
      this.status >= 500 ||
      this.code === "STORAGE_UNAVAILABLE" ||
      this.code === "COMPUTE_UNAVAILABLE" ||
      this.code === "CHAIN_UNAVAILABLE" ||
      this.code === "SOURCE_UNAVAILABLE"
    );
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

/** Narrow an unknown query error to a specific server code, for the inline-error branches. */
export function hasErrorCode(error: unknown, ...codes: (ErrorCode | string)[]): boolean {
  return isApiError(error) && codes.includes(error.code);
}

type QueryValue = string | number | boolean | undefined | null;

function buildUrl(path: string, query?: Record<string, QueryValue>): string {
  // API_URL may be a full origin ("http://127.0.0.1:8080") or a path on this
  // one ("/api", which is how the app is served through a tunnel). `new URL`
  // needs a base for the second form, and there is only one sensible base.
  const url = new URL(`${API_URL}${path}`, window.location.origin);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === "") continue;
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

interface RequestOptions {
  method?: "GET" | "POST";
  query?: Record<string, QueryValue>;
  body?: unknown;
  signal?: AbortSignal;
  /** POST /v1/tasks/prepare requires one so a retried submit cannot double-charge. */
  idempotencyKey?: string;
}

/**
 * The session token for the address the wallet is on right now.
 *
 * Read per request rather than captured once, and matched against the live
 * account rather than the one that signed in: the API resolves the acting
 * address from the session *before* it reads `creator` from the body, so a
 * token left over from a previous account would file a task under an address
 * the user had already switched away from.
 */
function authorization(): string | null {
  const token = tokenFor(getAccount(wagmiConfig).address);
  return token ? `Bearer ${token}` : null;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const url = buildUrl(path, options.query);
  const headers: Record<string, string> = { Accept: "application/json" };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;
  const bearer = authorization();
  if (bearer) headers.Authorization = bearer;

  let response: Response;
  try {
    response = await fetch(url, {
      method: options.method ?? "GET",
      headers,
      // Deliberately NOT credentials:"include". Sessions here are Bearer
      // tokens, never cookies, so there is nothing to send — and asking for
      // credentials makes the browser require Access-Control-Allow-Credentials
      // on every response, which turns an otherwise healthy API into an
      // opaque TypeError with no server-side trace of the request.
      credentials: "omit",
      signal: options.signal,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch (cause) {
    if (options.signal?.aborted) throw cause;
    throw new ApiError({ code: "CHAIN_UNAVAILABLE", message: `Cannot reach the ProofRelay API at ${API_URL}`, status: 0, url });
  }

  if (!response.ok) {
    const error = await toApiError(response, url);
    // The server is the authority on whether a token is still good. Holding one
    // it has already refused leaves the UI claiming to be signed in while every
    // authenticated request fails, and the fix — sign in again — is the one
    // action the UI would be hiding.
    if (error.status === 401) clearSession();
    throw error;
  }
  if (response.status === 204) return undefined as T;

  try {
    return (await response.json()) as T;
  } catch {
    throw new ApiError({ code: "INTERNAL", message: "The API returned a body that is not JSON", status: response.status, url });
  }
}

async function toApiError(response: Response, url: string): Promise<ApiError> {
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    /* a proxy or gateway answered, not the API */
  }
  const envelope = body as Partial<ApiErrorBody> | null;
  const error = envelope?.error;
  if (error && typeof error.code === "string" && typeof error.message === "string") {
    return new ApiError({ code: error.code, message: error.message, status: response.status, detail: error.detail ?? null, url });
  }
  return new ApiError({ code: fallbackCode(response.status), message: `${response.status} ${response.statusText || "request failed"}`, status: response.status, url });
}

function fallbackCode(status: number): ErrorCode {
  if (status === 401) return "UNAUTHORIZED";
  if (status === 404) return "TASK_NOT_FOUND";
  if (status === 409) return "CONTENT_HASH_MISMATCH";
  if (status === 429) return "RATE_LIMITED";
  if (status === 501) return "NOT_CONFIGURED";
  if (status >= 500) return "INTERNAL";
  return "VALIDATION_FAILED";
}

/* ── endpoints ───────────────────────────────────────────────────────────── */

export function getStats(signal?: AbortSignal): Promise<WorkspaceStats> {
  return request<WorkspaceStats>("/v1/stats", { signal });
}

export function listTasks(query: TaskListQuery = {}, signal?: AbortSignal): Promise<TaskListResponse> {
  return request<TaskListResponse>("/v1/tasks", { query: { status: query.status, q: query.q, creator: query.creator, limit: query.limit, cursor: query.cursor }, signal });
}

export function getTask(taskId: Bytes32 | string, signal?: AbortSignal): Promise<TaskDetail> {
  return request<TaskDetail>(`/v1/tasks/${encodeURIComponent(taskId)}`, { signal });
}

export function prepareTask(body: PrepareTaskRequest, idempotencyKey?: string, signal?: AbortSignal): Promise<PrepareTaskResponse> {
  return request<PrepareTaskResponse>("/v1/tasks/prepare", { method: "POST", body, idempotencyKey: idempotencyKey ?? newIdempotencyKey(), signal });
}

export function syncTask(taskId: Bytes32 | string, signal?: AbortSignal): Promise<SyncResponse> {
  return request<SyncResponse>(`/v1/tasks/${encodeURIComponent(taskId)}/sync`, { method: "POST", signal });
}

export function prepareChallenge(taskId: Bytes32 | string, body: PrepareChallengeRequest, idempotencyKey?: string, signal?: AbortSignal): Promise<PrepareChallengeResponse> {
  // Same rule as /v1/tasks/prepare: the route requires the header on its first
  // line, so omitting it fails the whole dispute path with VALIDATION_FAILED
  // before the body is ever read.
  return request<PrepareChallengeResponse>(`/v1/tasks/${encodeURIComponent(taskId)}/challenge`, {
    method: "POST",
    body,
    idempotencyKey: idempotencyKey ?? newIdempotencyKey(),
    signal,
  });
}

export function getReport(reportHash: Bytes32 | string, signal?: AbortSignal): Promise<ReportFetchResponse> {
  return request<ReportFetchResponse>(`/v1/reports/${encodeURIComponent(reportHash)}`, { signal });
}

export function listVerifiers(query: { status?: string; q?: string } = {}, signal?: AbortSignal): Promise<VerifierListResponse> {
  return request<VerifierListResponse>("/v1/verifiers", { query: { status: query.status, q: query.q }, signal });
}

/**
 * `offset` and `cursor` are two ways to page and the API refuses both at once.
 * The Artifacts table uses `offset`, because numbered pages have to address a
 * page directly and a keyset cursor can only ever walk forward from where it is.
 */
export function listArtifacts(query: { kind?: string; q?: string; limit?: number; cursor?: string; offset?: number } = {}, signal?: AbortSignal): Promise<ArtifactListResponse> {
  return request<ArtifactListResponse>("/v1/artifacts", { query: { kind: query.kind, q: query.q, limit: query.limit, cursor: query.cursor, offset: query.offset }, signal });
}

export function listActivity(query: { category?: string; q?: string; limit?: number; cursor?: string } = {}, signal?: AbortSignal): Promise<ActivityListResponse> {
  return request<ActivityListResponse>("/v1/activity", { query: { category: query.category, q: query.q, limit: query.limit, cursor: query.cursor }, signal });
}

export function getHealth(signal?: AbortSignal): Promise<HealthResponse> {
  return request<HealthResponse>("/health", { signal });
}

export function authNonce(address: Address, signal?: AbortSignal): Promise<NonceResponse> {
  return request<NonceResponse>("/v1/auth/nonce", { method: "POST", body: { address }, signal });
}

export function authVerify(body: VerifyRequest, signal?: AbortSignal): Promise<VerifyResponse> {
  return request<VerifyResponse>("/v1/auth/verify", { method: "POST", body, signal });
}

/**
 * Revokes the bearer token this browser holds. Clearing localStorage alone
 * would leave the session live on the server for the rest of its TTL, which is
 * not what "sign out" means to anyone who clicks it.
 */
export function authLogout(signal?: AbortSignal): Promise<void> {
  return request<void>("/v1/auth/logout", { method: "POST", signal });
}

/** Random enough that a double-submit reuses one key only when it is the same submit. */
function newIdempotencyKey(): string {
  const webcrypto = globalThis.crypto as Crypto | undefined;
  if (webcrypto?.randomUUID) return webcrypto.randomUUID();
  const bytes = new Uint8Array(16);
  webcrypto?.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
