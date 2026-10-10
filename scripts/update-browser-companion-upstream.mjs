#!/usr/bin/env node
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = join(root, "browser-companion", "upstream-manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const args = process.argv.slice(2);
const sourceIndex = args.indexOf("--source");
const checkOnly = args.includes("--check");
let source = sourceIndex >= 0 ? resolve(args[sourceIndex + 1] ?? "") : null;
let temporary = null;

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd:options.cwd ?? root,
    encoding:"utf8",
    maxBuffer:64 * 1024 * 1024,
  });
  if (options.allowDifference && result.status === 1) return result;
  if (result.status !== 0) {
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    throw new Error(`${command} ${commandArgs.join(" ")} failed${output ? `:\n${output}` : ""}`);
  }
  return result;
}

try {
  if (!source) {
    temporary = mkdtempSync(join(tmpdir(), "codexify-browser-upstream-"));
    source = join(temporary, "codex-chatgpt-web");
    run("gh", ["repo", "clone", manifest.repository, source, "--", "--filter=blob:none", "--no-checkout"]);
    run("git", ["checkout", "--detach", manifest.commit], { cwd:source });
  }
  const commit = run("git", ["rev-parse", "HEAD"], { cwd:source }).stdout.trim();
  if (commit !== manifest.commit) {
    throw new Error(`Expected upstream ${manifest.commit}, found ${commit}`);
  }

  for (const entry of [...manifest.wholeFiles, ...manifest.derivedSymbols]) {
    const local = readFileSync(join(root, entry.local), "utf8");
    if (!local.includes(manifest.commit)) {
      throw new Error(`${entry.local} does not record upstream commit ${manifest.commit}`);
    }
  }
  console.log(`Upstream ${manifest.repository} ${manifest.tag} ${manifest.commit}`);
  console.log("\nWhole-file adaptation diffs:");
  for (const entry of manifest.wholeFiles) {
    console.log(`\n--- ${entry.source} -> ${entry.local} ---`);
    if (checkOnly) continue;
    const result = run("git", [
      "diff", "--no-index", "--no-ext-diff", "--unified=3", "--",
      join(source, entry.source), join(root, entry.local),
    ], { allowDifference:true });
    process.stdout.write(result.stdout || "(no differences)\n");
  }
  console.log("\nDerived symbol anchors:");
  for (const entry of manifest.derivedSymbols) {
    console.log(`\n--- ${entry.source} -> ${entry.local} ---`);
    const pattern = entry.symbols.map(symbol => symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
    const result = run("rg", ["-n", pattern, join(source, entry.source)]);
    process.stdout.write(result.stdout);
  }
  console.log("\nBrowser companion upstream boundary is current.");
} finally {
  if (temporary) rmSync(temporary, { recursive:true, force:true });
}
