#!/usr/bin/env node
/**
 * Runs the whole stack locally without Docker: API (with indexer and keeper),
 * both verifiers, the adjudicator, and the web dev server. Streams every log
 * with a prefix so one terminal is enough to watch a task move end to end.
 */
import { spawn } from "node:child_process";
import { describeConfig, loadConfig } from "@proofrelay/config";

const config = loadConfig();
console.log(describeConfig(config), "\n");

const SERVICES = [
  ["api", process.execPath, ["apps/api/dist/server.js"], {}],
  ["verifier-a", process.execPath, ["workers/verifier/dist/main.js"], { VERIFIER_PROFILE: "a" }],
  ["verifier-b", process.execPath, ["workers/verifier/dist/main.js"], { VERIFIER_PROFILE: "b" }],
  ["adjudicator", process.execPath, ["workers/adjudicator/dist/main.js"], {}],
  ["web", "npm", ["--prefix", "proofrelay-frontend", "run", "dev"], {}],
];

const ESC = String.fromCharCode(27);
const COLORS = ["36", "32", "33", "35", "34"];
const children = [];

SERVICES.forEach(([name, command, args, extraEnv], index) => {
  const child = spawn(command, args, {
    cwd: config.root,
    env: { ...process.env, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const color = COLORS[index % COLORS.length];
  const tag = `${ESC}[${color}m${name.padEnd(11)}${ESC}[0m`;

  const pipe = (stream, out) => {
    let buffer = "";
    stream.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) out.write(`${tag} ${line}\n`);
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on("exit", (code) => process.stdout.write(`${tag} exited with code ${code}\n`));
  children.push(child);
});

const shutdown = () => {
  for (const child of children) child.kill("SIGTERM");
  setTimeout(() => process.exit(0), 500);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
