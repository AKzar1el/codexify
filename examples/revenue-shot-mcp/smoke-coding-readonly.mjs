// Nonmutating six-project direct-tool qualification. Prints no source contents.
import { loadRevenueConfig } from "./ledger.mjs";
import { makeHandler } from "./server.mjs";
import { readonlyFleetConfig } from "./coding-profile.mjs";

const filename = process.env.REVENUE_SHOT_PROJECTS_FILE;
const config = readonlyFleetConfig(await loadRevenueConfig(filename));
const handle = makeHandler(config);
let id = 1;
async function call(name, args) {
  const response = await handle({ jsonrpc: "2.0", id: id++,
    method: "tools/call", params: { name, arguments: args } });
  if (response.error || response.result?.isError) {
    throw new Error(String(response.result?.content?.[0]?.text || response.error?.message));
  }
  return response.result.structuredContent;
}
const listed = await handle({ jsonrpc: "2.0", id: id++, method: "tools/list" });
const names = listed.result.tools.map(x => x.name);
if (names.length !== 5 || !names.includes("read_project_file")
    || !names.includes("inspect_project_git")
    || names.includes("apply_project_edit")
    || names.includes("run_project_check")) {
  throw new Error("UNEXPECTED_LIVE_TOOL_SURFACE");
}
for (const project of Object.keys(config.projects).sort()) {
  const sample = project === "godprompt" ? "god-prompt/README.md" : "README.md";
  const source = await call("read_project_file",
    { project, path: sample, limit: 1 });
  if (!source.returnedLines || source.sha256.length !== 64) {
    throw new Error("INVALID_SOURCE_PROOF_" + project);
  }
  const repos = project === "godprompt" ? ["primary", "companion"] : ["root"];
  for (const repository of repos) {
    const git = await call("inspect_project_git", { project, repository });
    if (git.head.length !== 40) throw new Error("INVALID_GIT_SHA_" + project);
  }
  process.stdout.write(project + ": SOURCE_AND_GIT_VERIFIED (read-only)\n");
}
