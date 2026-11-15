import { randomBytes } from "node:crypto";
import { open, lstat, mkdir, readFile, unlink } from "node:fs/promises";
import { isAbsolute, dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const WAIT_MS = 150;
const MAX_WAIT_MS = 60_000;

/**
 * A cross-process Send gate for *separate* browser companions.
 *
 * The lock is created with O_EXCL and holds through semantic acceptance.
 * On a process crash it intentionally remains in place: a stale lock
 * must be inspected by the owner, never silently stolen to retry a Send.
 * With one companion the gate is opt-in and the existing behavior remains.
 */
export async function withSharedProviderSendGate<T>(
  actionId: string, signal: AbortSignal, operation: () => Promise<T>,
  path = process.env.CODEXIFY_BROWSER_SEND_GATE_PATH,
): Promise<T> {
  if (!path) return operation();
  if (!isAbsolute(path) || resolve(path) !== path) {
    throw new Error("Provider Send gate path must be an absolute normalized path");
  }
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const directory = await lstat(parent);
  if (!directory.isDirectory() || directory.isSymbolicLink()) {
    throw new Error("Provider Send gate parent must be a real directory");
  }
  const owner = randomBytes(16).toString("hex");
  const started = Date.now();
  let acquired = false;
  while (!acquired) {
    signal.throwIfAborted();
    try {
      const file = await open(path, "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify({ version: 1, actionId, owner }));
        await file.sync();
        acquired = true;
      } catch (error) {
        // A failed write is still ours, but the lock is unusable.
        await file.close();
        await unlink(path).catch(() => {});
        throw error;
      } finally {
        await file.close().catch(() => {});
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      if (Date.now() - started > MAX_WAIT_MS) {
        throw new Error("Provider Send admission timed out; do not resend the action");
      }
      await delay(WAIT_MS, undefined, { signal });
    }
  }
  try {
    signal.throwIfAborted();
    return await operation();
  } finally {
    try {
      const current = JSON.parse(await readFile(path, "utf8"));
      if (current.owner !== owner || current.actionId !== actionId) {
        throw new Error("Provider Send gate ownership changed; refusing unsafe release");
      }
      await unlink(path);
    } catch (error) {
      // Fail closed: ownership problems must not be bypassed.
      throw new Error("Could not safely release provider Send gate", { cause: error });
    }
  }
}
