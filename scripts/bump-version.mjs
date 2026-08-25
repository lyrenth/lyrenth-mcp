#!/usr/bin/env node
/**
 * Bump every version declaration at once, so they cannot drift apart.
 *
 * Usage: node scripts/bump-version.mjs 0.1.6
 *
 * Writes package.json, server.json (top level and every packages[] entry),
 * manifest.json, and the McpServer version literals in src/index.ts and
 * src/http.ts. It does not tag, build, publish, or touch the lockfile
 * version field beyond npm's own bookkeeping.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const next = process.argv[2];

if (!next || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(next)) {
  console.error("usage: node scripts/bump-version.mjs <semver>   e.g. 0.1.6");
  process.exit(1);
}

const edit = (file, fn) => {
  const path = join(root, file);
  const raw = readFileSync(path, "utf8");
  const json = JSON.parse(raw);
  fn(json);
  // Preserve the file's trailing newline convention.
  writeFileSync(path, JSON.stringify(json, null, 2) + (raw.endsWith("\n") ? "\n" : ""));
  console.log(`  ${file}`);
};

console.log(`setting version ${next} in:`);
edit("package.json", (j) => { j.version = next; });
edit("server.json", (j) => {
  j.version = next;
  for (const p of j.packages ?? []) p.version = next;
});
edit("manifest.json", (j) => { j.version = next; });

// The entry points hand McpServer a version literal; rewrite both so the
// handshake reports the version being released rather than a stale one.
const editLiteral = (file, re) => {
  const path = join(root, file);
  const raw = readFileSync(path, "utf8");
  const out = raw.replace(re, (m, pre) => `${pre}"${next}"`);
  if (out === raw) {
    console.error(`  ${file}: no version literal matched; fix by hand`);
    process.exitCode = 1;
    return;
  }
  writeFileSync(path, out);
  console.log(`  ${file}`);
};
editLiteral("src/index.ts", /(version:\s*)"[^"]+"/);
editLiteral("src/http.ts", /(SERVER_VERSION\s*=\s*)"[^"]+"/);

console.log(`\nnext: npm install --package-lock-only && node scripts/check-version.mjs`);
