/**
 * PM2 process definitions for the whole ProofRelay stack.
 *
 *   pm2 start ecosystem.config.cjs      # all five services
 *   pm2 save                            # survive a reboot (see docs/DEPLOYMENT.md)
 *
 * WHAT RUNS HERE, and why each one is not optional for an end-to-end run:
 *   api          HTTP API + chain indexer + keeper. Without it nothing is
 *                indexed and finalizeConsensus is never called.
 *   verifier-a   The two independent verifiers. A task with no verifier
 *   verifier-b   committing simply expires.
 *   adjudicator  Second-pass review of a challenged task.
 *   web          The Evidence Ledger UI, served as a static build by
 *                proofrelay-frontend/server — NOT the Vite dev server. A dev
 *                server exposes source and an HMR socket, and its port floats
 *                when the configured one is busy, which is the opposite of what
 *                a tunnel in front of it needs.
 *
 * ENV: these processes load .env / .env.local / .env.<role> themselves through
 * @proofrelay/config, so PM2 does not repeat any of it. The only values set
 * below are the ones PM2 alone can decide: which verifier profile a process is,
 * and where the web server listens.
 *
 * NODE_ENV=production is load-bearing for the API, not decoration: below it the
 * CORS layer accepts any loopback origin, and at it only CORS_ORIGINS is
 * allowed. The deployed UI is in that list; a stray localhost page is not.
 *
 * BUILD FIRST. Every script below is compiled output:
 *   npm run build && npm run build:web
 */
const path = require("node:path");

const root = __dirname;

/**
 * The node that runs the services. `process.execPath` is the node running the
 * pm2 CLI — the same one that built the project when the two commands are run
 * from one shell, which is what keeps a build and its runtime on one version.
 * PM2's own daemon may be on an older node; do not inherit it by accident.
 */
const interpreter = process.env.PM2_NODE || process.execPath;

/** Where the UI listens. 3000-3004 and 3006-3008 are taken on this host. */
const webPort = process.env.WEB_PORT || "3005";

const common = {
  cwd: root,
  interpreter,
  autorestart: true,
  // Postgres and the chain RPC are both reachable-or-not at boot, and a service
  // that loses either exits. Backing off rather than hammering keeps a restart
  // loop from filling the log while the dependency comes up.
  exp_backoff_restart_delay: 2_000,
  max_memory_restart: "600M",
  merge_logs: true,
  time: true,
  // A worker may be waiting on a receipt when the stop arrives. Every process
  // here handles SIGTERM; give it room to finish rather than SIGKILL mid-send.
  kill_timeout: 15_000,
};

function service(name, script, env = {}) {
  return {
    ...common,
    name: `proofrelay-${name}`,
    script,
    out_file: path.join(root, "logs", `${name}.log`),
    error_file: path.join(root, "logs", `${name}.error.log`),
    env: { NODE_ENV: "production", ...env },
  };
}

module.exports = {
  apps: [
    service("api", "apps/api/dist/server.js"),
    service("verifier-a", "workers/verifier/dist/main.js", { VERIFIER_PROFILE: "a" }),
    service("verifier-b", "workers/verifier/dist/main.js", { VERIFIER_PROFILE: "b" }),
    service("adjudicator", "workers/adjudicator/dist/main.js"),
    service("web", "proofrelay-frontend/dist/index.js", {
      PORT: webPort,
      // Where the web server's own /api proxy forwards. The browser normally
      // talks to the API directly through VITE_API_URL, so this is the fallback
      // path, not the main one.
      API_ORIGIN: process.env.API_ORIGIN || "http://127.0.0.1:8080",
    }),
  ],
};
