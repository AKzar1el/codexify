"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const path=require("node:path");
const {resolveBunExecutable}=require("../scripts/bun-executable.cjs");

test("non-Windows keeps the standard bun command",()=>{
  assert.equal(resolveBunExecutable({platform:"linux",exists:()=>false}),"bun");
});
test("Windows resolves official npm-installed bun.exe beside node.exe",()=>{
  const expected=path.win32.join("C:\\node","node_modules","bun","bin","bun.exe");
  assert.equal(resolveBunExecutable({platform:"win32",execPath:"C:\\node\\node.exe",env:{},exists:binary=>binary===expected}),expected);
});
test("Windows explicit executable path is honored",()=>{
  const expected="C:\\Tools With Spaces\\bun.exe";
  assert.equal(resolveBunExecutable({platform:"win32",execPath:"C:\\node\\node.exe",env:{CODEXIFY_BUN_EXECUTABLE:expected},exists:binary=>binary===expected}),expected);
});
test("Windows fails when no real executable exists",()=>{
  assert.throws(()=>resolveBunExecutable({platform:"win32",execPath:"C:\\node\\node.exe",env:{},exists:()=>false}),/missing/);
});
test("Windows rejects relative paths and wrappers for explicit override",()=>{
  assert.throws(()=>resolveBunExecutable({platform:"win32",execPath:"C:\\node\\node.exe",env:{CODEXIFY_BUN_EXECUTABLE:"bun.cmd"},exists:()=>true}),/absolute/);
  assert.throws(()=>resolveBunExecutable({platform:"win32",execPath:"C:\\node\\node.exe",env:{CODEXIFY_BUN_EXECUTABLE:"C:\\tools\\bun.cmd"},exists:()=>true}),/absolute/);
});