/**
 * Error codes. Every failure the operator or the UI can see has one, because
 * "an operator can act on it" is part of the definition of done
 * (architecture doc §24) and the runbook keys its alert table off these.
 */
export const ERROR_CODES = [
  "VALIDATION_FAILED",
  "PERSONAL_DATA_REJECTED",
  "SOURCE_UNAVAILABLE",
  "SOURCE_BLOCKED",
  "SOURCE_TOO_LARGE",
  "STORAGE_UNAVAILABLE",
  "STORAGE_UPLOAD_FAILED",
  "CONTENT_HASH_MISMATCH",
  "COMPUTE_UNAVAILABLE",
  "COMPUTE_TIMEOUT",
  "COMPUTE_INVALID_OUTPUT",
  "CHAIN_UNAVAILABLE",
  "CHAIN_REVERTED",
  "TASK_NOT_FOUND",
  "REPORT_NOT_FOUND",
  "ARTIFACT_NOT_FOUND",
  "SYNC_REQUIRED",
  "UNAUTHORIZED",
  "NONCE_INVALID",
  "SIGNATURE_INVALID",
  "SESSION_EXPIRED",
  "RATE_LIMITED",
  "IDEMPOTENCY_CONFLICT",
  "NOT_CONFIGURED",
  "INTERNAL",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export class ProofRelayError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly detail: Record<string, unknown> | undefined;
  readonly retryable: boolean;

  constructor(
    code: ErrorCode,
    message: string,
    options: { statusCode?: number; detail?: Record<string, unknown>; retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "ProofRelayError";
    this.code = code;
    this.statusCode = options.statusCode ?? defaultStatus(code);
    this.detail = options.detail;
    this.retryable = options.retryable ?? RETRYABLE.has(code);
  }

  toJSON() {
    return { error: { code: this.code, message: this.message, detail: this.detail ?? null } };
  }
}

const RETRYABLE = new Set<ErrorCode>([
  "STORAGE_UNAVAILABLE",
  "STORAGE_UPLOAD_FAILED",
  "COMPUTE_UNAVAILABLE",
  "COMPUTE_TIMEOUT",
  "CHAIN_UNAVAILABLE",
  "SOURCE_UNAVAILABLE",
]);

function defaultStatus(code: ErrorCode): number {
  switch (code) {
    case "VALIDATION_FAILED":
    case "PERSONAL_DATA_REJECTED":
    case "SOURCE_BLOCKED":
    case "SOURCE_TOO_LARGE":
    case "COMPUTE_INVALID_OUTPUT":
      return 400;
    case "UNAUTHORIZED":
    case "NONCE_INVALID":
    case "SIGNATURE_INVALID":
    case "SESSION_EXPIRED":
      return 401;
    case "TASK_NOT_FOUND":
    case "REPORT_NOT_FOUND":
    case "ARTIFACT_NOT_FOUND":
      return 404;
    case "CONTENT_HASH_MISMATCH":
    case "IDEMPOTENCY_CONFLICT":
      return 409;
    case "RATE_LIMITED":
      return 429;
    case "NOT_CONFIGURED":
      return 501;
    case "STORAGE_UNAVAILABLE":
    case "COMPUTE_UNAVAILABLE":
    case "CHAIN_UNAVAILABLE":
    case "SOURCE_UNAVAILABLE":
      return 503;
    case "COMPUTE_TIMEOUT":
      return 504;
    default:
      return 500;
  }
}

/** Retry with exponential backoff and jitter (PRD non-functional: Reliability). */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: {
    attempts?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
    shouldRetry?: (error: unknown) => boolean;
  } = {},
): Promise<T> {
  const attempts = options.attempts ?? 3;
  const base = options.baseDelayMs ?? 500;
  const max = options.maxDelayMs ?? 8_000;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      const retryable = options.shouldRetry
        ? options.shouldRetry(error)
        : !(error instanceof ProofRelayError) || error.retryable;
      if (!retryable || attempt === attempts) break;
      const delay = Math.min(max, base * 2 ** (attempt - 1)) * (0.5 + Math.random() * 0.5);
      options.onRetry?.(error, attempt, delay);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}
