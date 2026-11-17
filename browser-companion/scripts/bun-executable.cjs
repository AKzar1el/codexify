"use strict";
const fs=require("node:fs");
const path=require("node:path");

/**
 * Node spawnSync(shell:false) cannot execute bun.cmd on Windows. Resolve an
 * actual bun.exe from known installation layouts, never a shell wrapper.
 */
function resolveBunExecutable({
  platform=process.platform, execPath=process.execPath,
  env=process.env, exists=fs.existsSync,
}={}) {
  if(platform!=="win32")return "bun";
  const configured=env.CODEXIFY_BUN_EXECUTABLE;
  if(configured && (!path.win32.isAbsolute(configured)||!configured.toLowerCase().endsWith(".exe")))
    throw new Error("CODEXIFY_BUN_EXECUTABLE must be an absolute .exe");
  const candidates=[
    configured,
    path.win32.join(path.win32.dirname(execPath),"node_modules","bun","bin","bun.exe"),
    env.APPDATA&&path.win32.join(env.APPDATA,"npm","node_modules","bun","bin","bun.exe"),
    env.USERPROFILE&&path.win32.join(env.USERPROFILE,".bun","bin","bun.exe"),
  ].filter(Boolean);
  for(const binary of candidates)if(path.win32.isAbsolute(binary)&&exists(binary))return binary;
  throw new Error("Bun executable missing: install the official bun.exe or set CODEXIFY_BUN_EXECUTABLE to its absolute path");
}
module.exports={resolveBunExecutable};