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
if (names.length !== 8 || !names.includes("read_project_file")
    || !names.includes("inspect_project_git")
    || !names.includes("read_project_journal")
    || !names.includes("inspect_project_worktrees")
    || !names.includes("read_project_worktree_file")
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
    const tree = await call("inspect_project_worktrees", { project, repository });
    if (!Array.isArray(tree.worktrees) || !tree.worktrees.length) {
      throw new Error("MISSING_REGISTERED_WORKTREES_" + project);
    }
    if (project === "gsc" && repository === "root") {
      const norm = value => value.replaceAll("\\", "/").toLowerCase();
      const source = tree.worktrees.find(item => item.readable && !item.locked
        && norm(item.path) === norm(config.projects.gsc));
      if (!source) throw new Error("GSC_CANONICAL_WORKTREE_NOT_FOUND");
      const preview = await call("read_project_worktree_file", {
        project, repository, worktree_id: source.id, path: "README.md", limit: 1
      });
      if (!preview.returnedLines || preview.head !== source.head) {
        throw new Error("WORKTREE_READ_FAILED");
      }
    }
  }
  process.stdout.write(project + ": SOURCE_GIT_WORKTREES_VERIFIED (read-only)\n");
}
