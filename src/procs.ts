import type { ChildProcess } from "node:child_process";

/**
 * Child processes are spawned detached, each as its own process-group leader, so a
 * timeout can kill the whole tree (sh's children, npm trees, …) — killing only the
 * direct child leaves grandchildren holding the stdio pipes and `close` never fires.
 * The cost of detaching is that Ctrl-C no longer reaches children automatically, so
 * every spawn is tracked here and reaped on SIGINT/SIGTERM/exit.
 */

const active = new Set<ChildProcess>();
const shutdownHooks = new Set<() => void>();
let handlersInstalled = false;

export function track(child: ChildProcess): void {
  active.add(child);
  child.once("exit", () => active.delete(child));
  installHandlers();
}

/**
 * Swallow EPIPE on the child's stdin when it closes the pipe early (a runner that
 * exits without reading its prompt) — the outcome is reported by `close`/`exit`,
 * and an unhandled stdin error would otherwise crash the whole process.
 */
export function swallowStdinErrors(child: ChildProcess): void {
  child.stdin?.on("error", () => {});
}

/**
 * Register a synchronous hook to run when the process is torn down (signal, exit) —
 * e.g. persisting run state so state.json never claims "running" after a Ctrl-C.
 * Returns an unregister function; callers must unregister on normal completion.
 */
export function onShutdown(hook: () => void): () => void {
  shutdownHooks.add(hook);
  installHandlers();
  return () => shutdownHooks.delete(hook);
}

/** SIGKILL the child's whole process group, then unblock our pipe ends. */
export function killTree(child: ChildProcess): void {
  if (child.pid !== undefined) {
    try {
      process.kill(-child.pid, "SIGKILL"); // negative pid = the group (detached spawn)
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    }
  }
  // Best effort only: stop further data flowing from a surviving tree. This does
  // NOT guarantee `close` fires — callers must settle on their own deadline
  // (see the timeout paths in nodes.ts / runners/claude.ts).
  child.stdout?.destroy();
  child.stderr?.destroy();
}

/**
 * Kill every tracked child and run the registered shutdown hooks, each at most
 * once. This is the teardown the exit/signal handlers invoke; exported so its
 * behavior is testable in-process (signal handlers themselves are not).
 */
export function shutdownAll(): void {
  for (const child of active) killTree(child);
  for (const hook of [...shutdownHooks]) {
    shutdownHooks.delete(hook); // run-once: a signal handler and the exit handler both land here
    try {
      hook();
    } catch {
      // a shutdown hook must never block teardown
    }
  }
}

// The lines below run once per process, so perTest coverage pins their mutants to
// the suite's first in-process spawn (a nodes.test.ts test), never to the wiring
// assertions in procs.test.ts — in-report they are unkillable. The wiring itself is
// asserted in procs.test.ts and exercised cross-process by the cli.test.ts SIGINT test.
function installHandlers(): void {
  if (handlersInstalled) return;
  // Stryker disable next-line BooleanLiteral: one-shot line; coverage never reaches the procs.test.ts no-stacking assertion (see above)
  handlersInstalled = true;
  // Stryker disable next-line StringLiteral: one-shot registration; coverage never reaches the procs.test.ts wiring assertions (see above)
  process.on("exit", shutdownAll);
  // Stryker disable next-line StringLiteral: one-shot registration; coverage never reaches the procs.test.ts wiring assertions (see above)
  process.once("SIGINT", () => {
    shutdownAll();
    process.exit(130);
  });
  // Stryker disable next-line StringLiteral: one-shot registration; coverage never reaches the procs.test.ts wiring assertions (see above)
  process.once("SIGTERM", () => {
    shutdownAll();
    process.exit(143);
  });
}
