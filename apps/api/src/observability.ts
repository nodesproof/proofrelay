/**
 * Structured logging and Prometheus metrics.
 *
 * The metric names are the ones the runbook's alert table keys off, so they are
 * a contract with operations rather than an implementation detail. Every log
 * line carries the correlation fields the architecture doc asks for — taskId,
 * requestId, verifierId, txHash, errorCode — because the only way to explain a
 * settlement after the fact is to join a task to its transaction.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogFields {
  taskId?: string | null;
  requestId?: string | null;
  verifierId?: string | null;
  txHash?: string | null;
  errorCode?: string | null;
  [key: string]: unknown;
}

export class Logger {
  private readonly threshold: number;
  private readonly base: LogFields;

  constructor(level = "info", base: LogFields = {}) {
    this.threshold = LEVELS[level as LogLevel] ?? LEVELS.info;
    this.base = base;
  }

  child(fields: LogFields): Logger {
    const logger = new Logger("info", { ...this.base, ...fields });
    (logger as unknown as { threshold: number }).threshold = this.threshold;
    return logger;
  }

  private emit(level: LogLevel, message: string, fields: LogFields = {}): void {
    if (LEVELS[level] < this.threshold) return;
    const line = { ts: new Date().toISOString(), level, message, ...this.base, ...fields };
    const stream = level === "error" || level === "warn" ? process.stderr : process.stdout;
    stream.write(`${JSON.stringify(line)}\n`);
  }

  debug(message: string, fields?: LogFields): void {
    this.emit("debug", message, fields);
  }
  info(message: string, fields?: LogFields): void {
    this.emit("info", message, fields);
  }
  warn(message: string, fields?: LogFields): void {
    this.emit("warn", message, fields);
  }
  error(message: string, fields?: LogFields): void {
    this.emit("error", message, fields);
  }
}

type Labels = Record<string, string>;

class Counter {
  readonly name: string;
  readonly help: string;
  private readonly values = new Map<string, { labels: Labels; value: number }>();

  constructor(name: string, help: string) {
    this.name = name;
    this.help = help;
  }

  inc(labels: Labels = {}, amount = 1): void {
    const key = serializeLabels(labels);
    const entry = this.values.get(key) ?? { labels, value: 0 };
    entry.value += amount;
    this.values.set(key, entry);
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    if (this.values.size === 0) lines.push(`${this.name} 0`);
    for (const { labels, value } of this.values.values()) {
      lines.push(`${this.name}${renderLabels(labels)} ${value}`);
    }
    return lines.join("\n");
  }
}

class Gauge {
  readonly name: string;
  readonly help: string;
  private readonly values = new Map<string, { labels: Labels; value: number }>();

  constructor(name: string, help: string) {
    this.name = name;
    this.help = help;
  }

  set(value: number, labels: Labels = {}): void {
    this.values.set(serializeLabels(labels), { labels, value });
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`];
    if (this.values.size === 0) lines.push(`${this.name} 0`);
    for (const { labels, value } of this.values.values()) {
      lines.push(`${this.name}${renderLabels(labels)} ${value}`);
    }
    return lines.join("\n");
  }
}

const BUCKETS = [10, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000, 60_000];

class Histogram {
  readonly name: string;
  readonly help: string;
  private readonly series = new Map<string, { labels: Labels; counts: number[]; sum: number; count: number }>();

  constructor(name: string, help: string) {
    this.name = name;
    this.help = help;
  }

  observe(valueMs: number, labels: Labels = {}): void {
    const key = serializeLabels(labels);
    const entry = this.series.get(key) ?? { labels, counts: new Array(BUCKETS.length).fill(0), sum: 0, count: 0 };
    for (let i = 0; i < BUCKETS.length; i += 1) {
      if (valueMs <= BUCKETS[i]!) entry.counts[i] = (entry.counts[i] ?? 0) + 1;
    }
    entry.sum += valueMs;
    entry.count += 1;
    this.series.set(key, entry);
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const { labels, counts, sum, count } of this.series.values()) {
      for (let i = 0; i < BUCKETS.length; i += 1) {
        lines.push(`${this.name}_bucket${renderLabels({ ...labels, le: String(BUCKETS[i]) })} ${counts[i] ?? 0}`);
      }
      lines.push(`${this.name}_bucket${renderLabels({ ...labels, le: "+Inf" })} ${count}`);
      lines.push(`${this.name}_sum${renderLabels(labels)} ${sum}`);
      lines.push(`${this.name}_count${renderLabels(labels)} ${count}`);
    }
    if (this.series.size === 0) {
      lines.push(`${this.name}_bucket{le="+Inf"} 0`, `${this.name}_sum 0`, `${this.name}_count 0`);
    }
    return lines.join("\n");
  }
}

function serializeLabels(labels: Labels): string {
  return Object.keys(labels)
    .sort()
    .map((key) => `${key}=${labels[key]}`)
    .join(",");
}

function renderLabels(labels: Labels): string {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return "";
  return `{${keys.map((key) => `${key}="${String(labels[key]).replace(/"/g, '\\"')}"`).join(",")}}`;
}

export const metrics = {
  taskCreated: new Counter("task_created_total", "Tasks created onchain and indexed"),
  taskCompleted: new Counter("task_completed_total", "Tasks that reached a terminal state"),
  verifierCommit: new Counter("verifier_commit_total", "Report commitments observed"),
  verifierReveal: new Counter("verifier_reveal_total", "Report reveals observed"),
  disputeOpened: new Counter("dispute_opened_total", "Challenges opened"),
  payout: new Counter("payout_total", "Reward allocations, in wei"),
  jobRetry: new Counter("job_retry_total", "Orchestrator job retries"),
  chainSyncLag: new Gauge("chain_sync_lag_blocks", "Head block minus last indexed block"),
  computeLatency: new Histogram("compute_request_latency_ms", "0G Compute request latency"),
  storageLatency: new Histogram("storage_upload_latency_ms", "0G Storage upload latency"),
  httpLatency: new Histogram("http_request_latency_ms", "API request latency"),

  render(): string {
    return [
      metrics.taskCreated,
      metrics.taskCompleted,
      metrics.verifierCommit,
      metrics.verifierReveal,
      metrics.disputeOpened,
      metrics.payout,
      metrics.jobRetry,
      metrics.chainSyncLag,
      metrics.computeLatency,
      metrics.storageLatency,
      metrics.httpLatency,
    ]
      .map((metric) => metric.render())
      .join("\n\n")
      .concat("\n");
  },
};
