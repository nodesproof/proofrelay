/**
 * The verifier is a layer, not a directory. It talks to the chain, to 0G
 * Storage and to 0G Compute, and to nothing of ours: not the API, not the
 * database, not the web app. That is what lets a third party run one without
 * running the rest — and it is the kind of boundary that erodes one convenient
 * import at a time, so it is asserted here rather than assumed.
 *
 * Source scans rather than a build graph: the point is to fail on the commit
 * that adds the import, before anything is compiled.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(fileURLToPath(import.meta.url), "..", "..");

function sources(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (name === "node_modules" || name === "dist") continue;
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
    }
  };
  walk(dir);
  return out;
}

const IMPORT = /(?:^|\n)\s*(?:import|export)[^'"]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

function importsOf(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const specs: string[] = [];
  for (const m of text.matchAll(IMPORT)) specs.push(m[1] ?? m[2]);
  return specs;
}

/** Comments stripped, so a sentence that mentions the API is not a call to it. */
function codeOf(file: string): string {
  return readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const offenders = (files: string[], bad: (spec: string, file: string) => boolean) =>
  files.flatMap((file) => importsOf(file).filter((spec) => bad(spec, file)).map((spec) => `${relative(root, file)} -> ${spec}`));

const intoApps = (spec: string, file: string) =>
  spec.startsWith("@proofrelay/api") || /(^|\/)apps\//.test(resolve(file, "..", spec));
const intoWorkers = (spec: string, file: string) =>
  spec.startsWith("@proofrelay/worker") || /(^|\/)workers\//.test(resolve(file, "..", spec));

describe("layer boundaries", () => {
  const workers = sources(join(root, "workers"));
  const apps = sources(join(root, "apps"));
  const packages = sources(join(root, "packages"));

  it("workers never import the application", () => {
    expect(offenders(workers, intoApps)).toEqual([]);
  });

  it("the application never imports a worker", () => {
    expect(offenders(apps, intoWorkers)).toEqual([]);
  });

  it("shared packages know nothing about their consumers", () => {
    expect(offenders(packages, (s, f) => intoApps(s, f) || intoWorkers(s, f))).toEqual([]);
  });

  it("workers do not call the API over HTTP or touch its database", () => {
    // The verifier reads the chain, storage and compute directly. A URL to our
    // own API, or a Postgres client, in a worker is the coupling this exists
    // to catch — the one that would make a standalone verifier quietly depend
    // on a machine it does not run.
    const hits = workers.flatMap((file) => {
      const code = codeOf(file);
      const found = [
        /\bAPI_URL\b/.test(code) && "API_URL",
        /["'`]\/v1\/(tasks|reports|verifiers|artifacts|activity|stats|health)/.test(code) && "/v1/… route",
        /localhost:8080|api-proofrelay\./.test(code) && "API host",
        /\bDATABASE_URL\b|from ["']pg["']/.test(code) && "Postgres",
      ].filter(Boolean);
      return found.map((what) => `${relative(root, file)}: ${what}`);
    });
    expect(hits).toEqual([]);
  });
});
