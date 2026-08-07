import { describe, expect, test, vi } from "bun:test";
import { createRequire } from "node:module";

// The real fs, captured via require so vi.mock can't loop back on it.
const require = createRequire(import.meta.url);
const realFs = require("node:fs") as typeof import("node:fs");

// Two processes racing for one lock: acquireRunLock removes a stale lock and
// retries, but a competitor re-creates the lock before the retry's openSync.
// The synchronous window is unstageable with the real fs, so openSync is faked to
// throw EEXIST twice — the exact sequence the contended branch requires.
let failures = 0;

vi.mock("node:fs", () => {
  return {
    ...realFs,
    openSync: (...args: Parameters<typeof realFs.openSync>) => {
      if (failures > 0) {
        failures--;
        const err = new Error("EEXIST") as NodeJS.ErrnoException;
        err.code = "EEXIST";
        throw err;
      }
      return realFs.openSync(...args);
    },
  };
});

const { acquireRunLock, initRunDir } = await import("../src/state");
const { spawnSync } = await import("node:child_process");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");

describe("acquireRunLock contention", () => {
  test("a lock that reappears after the stale reclaim is reported as contended", () => {
    failures = 2; // attempt 0 EEXIST (stale), attempt 1 EEXIST (competitor re-created it)
    const deadPid = spawnSync("sh", ["-c", "exit 0"]).pid!;
    const root = realFs.mkdtempSync(join(tmpdir(), "sao-lock-"));
    const paths = initRunDir(root, "run-lock");
    realFs.writeFileSync(join(paths.dir, "engine.lock"), String(deadPid));
    expect(() => acquireRunLock(paths)).toThrow("is being contended by another sao process");
    expect(failures).toBe(0);
  });
});
