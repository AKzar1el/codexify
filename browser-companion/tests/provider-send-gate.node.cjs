const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const jiti = require("jiti")(__filename);
const { withSharedProviderSendGate } = jiti("../src/provider-send-gate.ts");

function directory() {
  const root = fs.realpathSync(os.tmpdir());
  const dir = fs.mkdtempSync(path.join(root, "codexify-sendgate-"));
  assert.equal(path.dirname(fs.realpathSync(dir)), root);
  return dir;
}
async function child(gate, label, duration) {
  const code = [
    'const jiti=require("jiti")(process.argv[1])',
    'const {withSharedProviderSendGate}=jiti(process.argv[1])',
    'const path=process.argv[2]',
    'const label=process.argv[3]',
    'const ms=Number(process.argv[4])',
    'withSharedProviderSendGate(label, new AbortController().signal,async()=>{',
    '  const enter=Date.now();',
    '  await new Promise(resolve=>setTimeout(resolve,ms));',
    '  const exit=Date.now();',
    '  console.log(JSON.stringify({label,enter,exit}))',
    '},path).catch(e=>{console.error(e.message);process.exitCode=1})',
  ].join(";");
  const src = require.resolve("../src/provider-send-gate.ts");
  const processChild = spawn(process.execPath, ["-e", code, src, gate, label, String(duration)], {
    cwd: __dirname, stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  processChild.stdout.on("data", c => {stdout += c.toString()});
  processChild.stderr.on("data", c => {stderr += c.toString()});
  const status = await new Promise((resolve, reject) => {
    processChild.once("error", reject);
    processChild.once("close", resolve);
  });
  assert.equal(status, 0, stderr);
  return JSON.parse(stdout.trim());
}

test("two separate processes serialize the exact provider Send critical section", { timeout: 20000 },async () => {
  const dir = directory();
  const gate = path.join(dir, "provider.lock");
  try {
    const [a,b] = await Promise.all([child(gate,"lane-a",250),child(gate,"lane-b",250)]);
    assert(a.exit <= b.enter || b.exit <= a.enter, "overlapping Send was admitted");
    assert.equal(fs.existsSync(gate),false);
  } finally {fs.rmSync(dir,{recursive:true,force:true})}
});

test("an aborted second lane cannot steal another lane's Send lock", { timeout: 10000 },async () => {
  const dir = directory();
  const gate = path.join(dir, "provider.lock");
  try {
    fs.writeFileSync(gate,JSON.stringify({version:1,actionId:"first",owner:"first-owner"}),{flag:"wx"});
    const controller = new AbortController();
    const waiting = withSharedProviderSendGate("second",controller.signal,async()=> {
      throw new Error("never admitted");
    },gate);
    setTimeout(()=>controller.abort(new Error("canceled before Send")),150);
    await assert.rejects(waiting, error => error.name === "AbortError");
    assert.equal(JSON.parse(fs.readFileSync(gate,"utf8")).owner,"first-owner");
  } finally {fs.rmSync(dir,{recursive:true,force:true})}
});
