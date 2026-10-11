import { readFile, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

export async function privateChromeExecutable(browserRoot: string): Promise<string> {
  const root = resolve(browserRoot);
  const metadata = JSON.parse(await readFile(resolve(root, "chrome-executable.json"), "utf8"));
  if (typeof metadata.executable !== "string" || !metadata.executable || isAbsolute(metadata.executable)) {
    throw new Error("Private Chrome executable metadata is invalid");
  }
  const executable = resolve(root, metadata.executable);
  const path = relative(root, executable);
  if (!path || path.startsWith("..") || isAbsolute(path) || !(await stat(executable)).isFile()) {
    throw new Error("Private Chrome executable is missing or outside its runtime");
  }
  return executable;
}
