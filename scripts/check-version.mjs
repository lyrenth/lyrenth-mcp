#!/usr/bin/env node
/**
 * One version, six declarations. This fails the build when they disagree.
 *
 * package.json is the single source of truth. server.json (the MCP registry
 * record) carries the version twice, once at the top level and once per entry
 * in packages[], and manifest.json (the .mcpb bundle) carries it again. Each
 * one is read by a different installer, so a mismatch is invisible until a
 * user reports a version that does not exist.
 *
 * Usage:
 *   node scripts/check-version.mjs                 # files must agree
 *   node scripts/check-version.mjs --tag=v0.1.6    # ...and match a release tag
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => JSON.parse(readFileSync(join(root, f), "utf8"));

const pkg = read("package.json");
const server = read("server.json");
const manifest = read("manifest.json");
const truth = pkg.version;

// The two entry points hand their own version string to McpServer, so a
// stale literal there reports a version that does not exist to every
// connected client. Caught live at 0.1.6: both still said 0.1.5.
const versionLiteral = (file) => {
  const src = readFileSync(join(root, file), "utf8");
  const m = src.match(/version:\s*"([^"]+)"|SERVER_VERSION\s*=\s*"([^"]+)"/);
  return m ? (m[1] ?? m[2]) : "(no version literal found)";
};

const found = [
  { where: "package.json version", value: pkg.version },
  { where: "server.json version", value: server.version },
  { where: "manifest.json version", value: manifest.version },
  { where: "src/index.ts McpServer version", value: versionLiteral("src/index.ts") },
  { where: "src/http.ts SERVER_VERSION", value: versionLiteral("src/http.ts") },
  ...(server.packages ?? []).map((p, i) => ({
    where: `server.json packages[${i}] (${p.identifier}) version`,
    value: p.version,
  })),
];

const problems = found.filter((f) => f.value !== truth);

// The registry resolves the npm package by name, so a typo here publishes a
// record pointing at someone else's package.
for (const [i, p] of (server.packages ?? []).entries()) {
  if (p.registryType === "npm" && p.identifier !== pkg.name) {
    problems.push({
      where: `server.json packages[${i}] identifier`,
      value: `${p.identifier} (expected ${pkg.name})`,
    });
  }
}

// The registry verifies ownership by reading mcpName out of the published
// npm package, so losing it breaks publishing in a way npm will not warn about.
if (!pkg.mcpName) {
  problems.push({ where: "package.json mcpName", value: "missing" });
} else if (pkg.mcpName !== server.name) {
  problems.push({
    where: "package.json mcpName",
    value: `${pkg.mcpName} (expected ${server.name})`,
  });
}

const tagArg = process.argv.find((a) => a.startsWith("--tag="));
if (tagArg) {
  const tag = tagArg.slice("--tag=".length).replace(/^v/, "");
  if (tag !== truth) {
    problems.push({ where: "git tag", value: `${tag} (expected ${truth})` });
  }
}

if (problems.length) {
  console.error(`version drift: package.json says ${truth}\n`);
  for (const p of problems) console.error(`  ${p.where}: ${p.value}`);
  console.error(`\nRun: node scripts/bump-version.mjs ${truth}`);
  process.exit(1);
}

console.log(`version ${truth} consistent across ${found.length} declarations`);
