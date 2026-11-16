#!/usr/bin/env node
"use strict";
// Stage only the rebuilt main.js in the existing Windows companion candidate.
// Never mutate the installed production app.asar or any Chrome profile.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const asar = require("@electron/asar");

const root = path.resolve(__dirname, "..");
const built = path.join(root, "dist", "main.js");
const candidate = path.join(root, "release", "win-unpacked", "resources", "app.asar");
const backupDir = path.join(root, "artifacts", "candidate-backups");
const sha = path => crypto.createHash("sha256").update(fs.readFileSync(path)).digest("hex");

async function main() {
  for (const file of [built, candidate]) {
    if (!fs.statSync(file, {throwIfNoEntry:false})?.isFile()) throw new Error(`Missing candidate: ${file}`);
  }
  const bundle = fs.readFileSync(built);
  if (!bundle.includes(Buffer.from("assertConversationLoadAvailableBeforeTab"))) {
    throw new Error("Built bundle lacks the tab-churn preflight guard");
  }
  if (!asar.listPackage(candidate).includes("\\dist\\main.js")) {
    throw new Error("Existing ASAR lacks expected main.js entry");
  }
  const original = sha(candidate);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "codexify-tab-churn-asar-"));
  let changed = false;
  let backup;
  try {
    const expanded = path.join(temporary, "expanded");
    asar.extractAll(candidate, expanded);
    const metadata = fs.readFileSync(path.join(expanded, "package.json"));
    fs.writeFileSync(path.join(expanded, "dist", "main.js"), bundle);
    const archive = path.join(temporary, "app.asar");
    await asar.createPackage(expanded, archive);
    if (!asar.extractFile(archive, "dist/main.js").equals(bundle)
      || !asar.extractFile(archive, "package.json").equals(metadata)) {
      throw new Error("Staged ASAR failed bundle/manifest verification");
    }
    fs.mkdirSync(backupDir, {recursive:true});
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    backup = path.join(backupDir, `pre-tab-churn-${stamp}.asar`);
    fs.copyFileSync(candidate, backup, fs.constants.COPYFILE_EXCL);
    if (sha(candidate) !== original || sha(backup) !== original) {
      throw new Error("Candidate changed while staging; refuse overwrite");
    }
    changed = true;
    fs.copyFileSync(archive, candidate);
    if (sha(candidate) !== sha(archive)) throw new Error("Staged browser archive checksum mismatch");
    console.log(`CANDIDATE_BROWSER_ASAR_READY sha256=${sha(candidate)}`);
    console.log(`ORIGINAL_CANDIDATE_BACKUP=${backup}`);
    console.log("PRODUCTION_BROWSER_UNCHANGED=true");
  } catch (error) {
    if (changed && backup && fs.existsSync(backup)) fs.copyFileSync(backup, candidate);
    throw error;
  } finally {
    fs.rmSync(temporary, {recursive:true,force:true});
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
