/**
 * The one place an exception becomes an HTTP response.
 *
 * Two rules the architecture doc and the threat model both lean on:
 *
 *   - Every failure an operator or the UI can see carries an `ErrorCode`. The
 *     runbook's alert table keys off those codes, so an unmapped exception
 *     becoming a bare 500 with a prose message is a hole in operations, not a
 *     cosmetic issue. Unknown errors are still 500 INTERNAL — but they are
 *     logged with the correlation fields that let someone find them.
 *   - Nothing internal crosses the boundary. Stack traces stay in the log, and
 *     any string that happens to contain a configured secret is scrubbed on the
 *     way out. A private key reaching a client through an error message would
 *     be the worst bug in this codebase, so the scrub runs over every response
 *     body regardless of where the message came from.
 */
import { ZodError } from "zod";
import { ProofRelayError, type ErrorCode } from "@proofrelay/schemas";
import type { LogFields, Logger } from "../observability.js";

export interface ErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    detail: Record<string, unknown> | null;
  };
}

export interface MappedError {
  statusCode: number;
  body: ErrorBody;
  /** 5xx — the operator needs to see this one, the client cannot act on it. */
  internal: boolean;
  /** Kept for the log line only; never serialised into `body`. */
  cause: unknown;
}

/**
 * Env keys whose values must never appear in a response or a log line. Matched
 * on the key, so a new `*_PRIVATE_KEY` is covered the day it is added rather
 * than the day someone remembers to extend a list of literals.
 */
const SECRET_KEY_PATTERN = /(KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|DATABASE_URL|DSN)$/i;
const MIN_SECRET_LENGTH = 8;

function secretValues(env: NodeJS.ProcessEnv = process.env): string[] {
  const values: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (!value || value.length < MIN_SECRET_LENGTH) continue;
    if (SECRET_KEY_PATTERN.test(key)) values.push(value);
  }
  // Longest first, so a value that contains another is replaced whole.
  return values.sort((a, b) => b.length - a.length);
}

export function scrubSecrets(text: string, env: NodeJS.ProcessEnv = process.env): string {
  let out = text;
  for (const secret of secretValues(env)) {
    if (out.includes(secret)) out = out.split(secret).join("[redacted]");
  }
  return out;
}

function scrubDetail(detail: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (!detail) return null;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(detail)) {
    out[key] = typeof value === "string" ? scrubSecrets(value) : value;
  }
  return out;
}

/** `["claims", 0, "text"]` reads better in a form than `claims.0.text`. */
function fieldPath(path: readonly (string | number | symbol)[]): string {
  return path.map((segment) => String(segment)).join(".") || "(root)";
}

export function zodErrorBody(error: ZodError): ErrorBody {
  return {
    error: {
      code: "VALIDATION_FAILED",
      message: "request failed validation",
      detail: {
        fields: error.issues.map((issue) => ({
          path: fieldPath(issue.path),
          code: issue.code,
          message: issue.message,
        })),
      },
    },
  };
}

export function mapError(error: unknown): MappedError {
  if (error instanceof ProofRelayError) {
    return {
      statusCode: error.statusCode,
      body: {
        error: {
          code: error.code,
          message: scrubSecrets(error.message),
          detail: scrubDetail(error.detail),
        },
      },
      internal: error.statusCode >= 500,
      cause: error,
    };
  }

  if (error instanceof ZodError) {
    return { statusCode: 400, body: zodErrorBody(error), internal: false, cause: error };
  }

  // Fastify raises its own typed errors for a body over the limit, a malformed
  // JSON body and a tripped rate limiter. They are client mistakes, and turning
  // them into 500s would hide a 2 MB upload behind "internal error".
  const fastify = error as { statusCode?: number; code?: string; message?: string };
  if (typeof fastify?.statusCode === "number" && fastify.statusCode < 500) {
    return {
      statusCode: fastify.statusCode,
      body: {
        error: {
          code: fastifyErrorCode(fastify.statusCode, fastify.code),
          message: scrubSecrets(fastify.message ?? "request rejected"),
          detail: fastify.code ? { fastifyCode: fastify.code } : null,
        },
      },
      internal: false,
      cause: error,
    };
  }

  return {
    statusCode: 500,
    body: {
      error: {
        code: "INTERNAL",
        message: "internal error",
        detail: null,
      },
    },
    internal: true,
    cause: error,
  };
}

/**
 * There is no generic NOT_FOUND code, deliberately — a route that 404s is
 * supposed to say what it could not find by throwing the matching
 * ProofRelayError. This is the fall-through for one that did not, and
 * TASK_NOT_FOUND is the honest guess because every 404 this API serves today is
 * about a task.
 */
function fastifyErrorCode(statusCode: number, code: string | undefined): ErrorCode {
  if (statusCode === 429) return "RATE_LIMITED";
  if (statusCode === 401 || statusCode === 403) return "UNAUTHORIZED";
  if (statusCode === 404) return "TASK_NOT_FOUND";
  if (code === "FST_ERR_CTP_BODY_TOO_LARGE") return "SOURCE_TOO_LARGE";
  return "VALIDATION_FAILED";
}

/** What the log line needs to be joinable to a task, a request and a transaction. */
export interface RequestLike {
  id?: string;
  method?: string;
  url?: string;
  params?: unknown;
  headers?: Record<string, unknown>;
  routeOptions?: { url?: string };
}

export function correlationFields(request: RequestLike | undefined, extra: LogFields = {}): LogFields {
  const params = (request?.params ?? {}) as Record<string, unknown>;
  const taskId = typeof params.taskId === "string" ? params.taskId : null;
  return {
    requestId: request?.id ?? null,
    taskId,
    method: request?.method ?? null,
    route: request?.routeOptions?.url ?? request?.url ?? null,
    ...extra,
  };
}

export interface ReplyLike {
  code(statusCode: number): ReplyLike;
  send(payload: unknown): unknown;
}

/**
 * The Fastify error handler. Structurally typed rather than importing Fastify's
 * own signature so this stays unit-testable with a two-method fake, and so the
 * mapping can be reused by the orchestrator's job logging.
 */
export function errorHandler(logger: Logger) {
  return function handleError(error: unknown, request: RequestLike, reply: ReplyLike): unknown {
    const mapped = mapError(error);
    const fields = correlationFields(request, { errorCode: mapped.body.error.code });

    if (mapped.internal) {
      const cause = mapped.cause as Error | undefined;
      logger.error("request failed", {
        ...fields,
        detail: scrubSecrets(String(cause?.message ?? cause ?? "unknown")),
        stack: cause?.stack ? scrubSecrets(cause.stack) : null,
      });
    } else {
      logger.warn("request rejected", { ...fields, statusCode: mapped.statusCode });
    }

    return reply.code(mapped.statusCode).send(mapped.body);
  };
}
