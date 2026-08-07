import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { killTree, onShutdown, shutdownAll, swallowStdinErrors, track } from "../src/procs";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll `kill(pid, 0)` until the process is gone (ESRCH) or the deadline passes. */
async function eventuallyDead(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    if (Date.now() > deadline) return false;
    await sleep(25);
  }
}

/** A ChildProcess stand-in that records kill() calls instead of signalling anything. */
function fakeChild(pid: number | undefined): {
  child: ChildProcess;
  kills: string[];
  emitExit: () => void;
} {
  const emitter = new EventEmitter();
  const kills: string[] = [];
  const child = Object.assign(emitter, {
    pid,
    kill(signal?: NodeJS.Signals | number): boolean {
      kills.push(String(signal));
      return true;
    },
  }) as unknown as ChildProcess;
  return { child, kills, emitExit: () => void emitter.emit("exit", 0, null) };
}

describe("shutdown handler wiring", () => {
  test("registering a hook installs shutdownAll as the process exit handler", () => {
    const off = onShutdown(() => {});
    expect(process.listeners("exit")).toContain(shutdownAll);
    expect(process.listenerCount("SIGINT")).toBeGreaterThanOrEqual(1);
    expect(process.listenerCount("SIGTERM")).toBeGreaterThanOrEqual(1);
    off();
  });

  test("repeated track/onShutdown calls do not stack more process handlers", () => {
    const off1 = onShutdown(() => {});
    const counts = {
      exit: process.listenerCount("exit"),
      SIGINT: process.listenerCount("SIGINT"),
      SIGTERM: process.listenerCount("SIGTERM"),
    };

    const off2 = onShutdown(() => {});
    const fake = fakeChild(99_999_999);
    track(fake.child);
    fake.emitExit();

    expect(process.listenerCount("exit")).toBe(counts.exit);
    expect(process.listenerCount("SIGINT")).toBe(counts.SIGINT);
    expect(process.listenerCount("SIGTERM")).toBe(counts.SIGTERM);
    off1();
    off2();
  });

  test("the SIGINT handler runs shutdown hooks and exits with 130", () => {
    let hookRuns = 0;
    const off = onShutdown(() => {
      hookRuns += 1;
    });
    const handlers = process.listeners("SIGINT");
    expect(handlers.length).toBeGreaterThanOrEqual(1);

    const exitCalls: Array<number | string | null | undefined> = [];
    const realExit = process.exit;
    process.exit = ((code?: number | string | null) => {
      exitCalls.push(code);
    }) as unknown as typeof process.exit;
    try {
      for (const handler of handlers) (handler as () => void)();
    } finally {
      process.exit = realExit;
    }

    expect(hookRuns).toBe(1);
    expect(exitCalls).toContain(130);
    off();
  });

  test("the SIGTERM handler runs shutdown hooks and exits with 143", () => {
    let hookRuns = 0;
    const off = onShutdown(() => {
      hookRuns += 1;
    });
    const handlers = process.listeners("SIGTERM");
    expect(handlers.length).toBeGreaterThanOrEqual(1);

    const exitCalls: Array<number | string | null | undefined> = [];
    const realExit = process.exit;
    process.exit = ((code?: number | string | null) => {
      exitCalls.push(code);
    }) as unknown as typeof process.exit;
    try {
      for (const handler of handlers) (handler as () => void)();
    } finally {
      process.exit = realExit;
    }

    expect(hookRuns).toBe(1);
    expect(exitCalls).toContain(143);
    off();
  });
});

describe("killTree", () => {
  test(
    "settles a detached tree whose grandchild holds the stdio pipes",
    async () => {
      const child = spawn("sh", ["-c", "sleep 30; true"], {
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
      track(child);
      const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));

      await new Promise((resolve) => setTimeout(resolve, 200)); // let sh fork sleep
      const started = Date.now();
      killTree(child);
      await closed;
      expect(Date.now() - started).toBeLessThan(2000);
    },
    10000,
  );

  test("is safe to call on an already-exited child", async () => {
    const child = spawn("sh", ["-c", "true"], { stdio: ["ignore", "pipe", "pipe"], detached: true });
    track(child);
    await new Promise<void>((resolve) => child.once("close", () => resolve()));
    expect(() => killTree(child)).not.toThrow();
  });

  test(
    "SIGKILLs the whole process group, not just the direct child",
    async () => {
      // sh prints the pid of its backgrounded grandchild, then waits on it.
      const child = spawn("sh", ["-c", "sleep 30 & echo $!; wait"], {
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
      track(child);
      const grandchildPid = await new Promise<number>((resolve, reject) => {
        let buf = "";
        child.stdout?.on("data", (chunk: Buffer) => {
          buf += String(chunk);
          const match = buf.match(/^(\d+)\n/);
          if (match) resolve(Number(match[1]));
        });
        child.once("error", reject);
      });

      try {
        expect(() => process.kill(grandchildPid, 0)).not.toThrow(); // grandchild is alive
        killTree(child);
        // Only a group kill (negative pid, SIGKILL) reaches the grandchild.
        expect(await eventuallyDead(grandchildPid, 3000)).toBe(true);
      } finally {
        try {
          process.kill(grandchildPid, "SIGKILL");
        } catch {
          // already dead — the expected case
        }
        try {
          if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
        } catch {
          // already dead — the expected case
        }
      }
    },
    10000,
  );

  test("falls back to child.kill(SIGKILL) when the group kill fails", () => {
    // pid 99999999 exceeds any real pid, so process.kill(-pid) throws ESRCH.
    const { child, kills } = fakeChild(99_999_999);
    killTree(child);
    expect(kills).toEqual(["SIGKILL"]);
  });

  test("signals nothing when the child has no pid", () => {
    const { child, kills } = fakeChild(undefined);
    expect(() => killTree(child)).not.toThrow();
    expect(kills).toEqual([]);
  });

  test("tolerates a child spawned without stdio pipes", async () => {
    const child = spawn("sh", ["-c", "true"], { stdio: "ignore", detached: true });
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    expect(() => killTree(child)).not.toThrow();
  });
});

describe("track", () => {
  test("stops tracking a child once it exits", () => {
    const { child, kills, emitExit } = fakeChild(99_999_999);
    track(child);
    emitExit(); // the exit listener must drop it from the active set
    shutdownAll();
    expect(kills).toEqual([]);
  });
});

describe("swallowStdinErrors", () => {
  test("a stdin EPIPE from a child that exited early is swallowed, not a crash", () => {
    const stdin = new EventEmitter();
    const child = Object.assign(new EventEmitter(), { stdin }) as unknown as ChildProcess;
    expect(() => {
      swallowStdinErrors(child);
      stdin.emit("error", Object.assign(new Error("EPIPE"), { code: "EPIPE" }));
    }).not.toThrow();
  });

  test("a child without a stdin stream is tolerated", () => {
    const child = fakeChild(1).child;
    expect(() => swallowStdinErrors(child)).not.toThrow();
  });
});

describe("shutdownAll", () => {
  test(
    "kills tracked children that are still running",
    async () => {
      const child = spawn("sleep", ["30"], { stdio: "ignore", detached: true });
      track(child);
      try {
        const exited = new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(false), 3000);
          child.once("exit", () => {
            clearTimeout(timer);
            resolve(true);
          });
        });
        shutdownAll();
        expect(await exited).toBe(true);
      } finally {
        try {
          if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
        } catch {
          // already dead — the expected case
        }
      }
    },
    10000,
  );

  test("runs each shutdown hook exactly once across repeated calls", () => {
    let runs = 0;
    onShutdown(() => {
      runs += 1;
    });
    shutdownAll();
    shutdownAll();
    expect(runs).toBe(1);
  });

  test("a throwing hook does not prevent later hooks from running", () => {
    const order: string[] = [];
    onShutdown(() => {
      order.push("a");
      throw new Error("boom");
    });
    onShutdown(() => {
      order.push("b");
    });
    expect(() => shutdownAll()).not.toThrow();
    expect(order).toEqual(["a", "b"]);
  });

  test("an unregistered hook does not run", () => {
    let runs = 0;
    const off = onShutdown(() => {
      runs += 1;
    });
    off();
    shutdownAll();
    expect(runs).toBe(0);
  });
});
