#!/usr/bin/env node
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { loadConfig, describeConfig } from "@proofrelay/config";

const config = loadConfig();
const dir = join(config.root, "infra", "migrations");
const files = readdirSync(dir).filter((name) => name.endsWith(".sql")).sort();

const client = new pg.Client({ connectionString: config.api.databaseUrl });
await client.connect();
await client.query(
  `CREATE TABLE IF NOT EXISTS schema_migrations (
     name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
);
const applied = new Set((await client.query("SELECT name FROM schema_migrations")).rows.map((r) => r.name));

console.log(describeConfig(config));
for (const name of files) {
  if (applied.has(name)) {
    console.log(`  = ${name}`);
    continue;
  }
  const sql = readFileSync(join(dir, name), "utf8");
  await client.query("BEGIN");
  try {
    await client.query(sql);
    await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [name]);
    await client.query("COMMIT");
    console.log(`  + ${name}`);
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(`  ! ${name}: ${error.message}`);
    process.exitCode = 1;
    break;
  }
}
await client.end();
