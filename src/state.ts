import { createHash, randomBytes } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { SaoError } from "./errors";

export type RunStatus = "running" | "succeeded" | "failed" | "rejected";
export type NodeStatus = "pending" | "running" | "succeeded" | "failed" | "skipped" | "rejected";

export interface NodeState {
  status: NodeStatus;
  output?: string;
  sessionId?: string;
  /** Loop nodes: how many iterations ran. */
  iterations?: number;
  /** Interactive loops: the human feedback feeding the current iteration. */
  lastFeedback?: string;
  /**
   * Nodes with when_bash: set (and persisted) the moment the predicate passes.
   * Resume must not re-evaluate a passed predicate — the node's own partial work
   * can flip the answer and a false result would skip away loop progress or a
   * gate re-ask. Absent means the body never started: re-evaluate.
   */
  whenPassed?: boolean;
  startedAt?: string;
  endedAt?: string;
}

export interface RunState {
  id: string;
  workflow: string;
  workflowHash: string;
  task: string;
  vars: Record<string, string>;
  /** Persisted from `sao run`; the flag itself lands in M4. */
  autoOpenPr: boolean;
  createdAt: string;
  /** Pid of the process owning the run — liveness check for resume/clean while "running". */
  pid?: number;
  /** Execution dir relative to the repo root; only for in-place (--no-worktree) runs. */
  cwd?: string;
  /** Node concurrency the run started with; resume reuses it. */
  concurrency?: number;
  /** --runner override the run started with; resume reuses it. */
  runnerOverride?: string;
  /** Worktree path relative to the repo root; absent for in-place runs. */
  worktree?: string;
  /** Ref the worktree was cut from (as given, or the resolved HEAD SHA when defaulted). */
  base?: string;
  branch?: string;
  status: RunStatus;
  nodes: Record<string, NodeState>;
}

export interface RunPaths {
  dir: string;
  logsDir: string;
  stateFile: string;
}

export function createRunId(workflowName: string, now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  // Defense in depth: the schema already restricts workflow names, but the run id
  // becomes a filesystem path, so never let path characters through here either.
  const slug = workflowName.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "run";
  return `${stamp}-${slug}-${randomBytes(2).toString("hex")}`;
}

export function hashFile(path: string): string {
  return "sha256:" + createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Generate a run id and create its directory, retrying on the (rare) id collision. */
export function createRun(
  root: string,
  workflowName: string,
  makeId: () => string = () => createRunId(workflowName),
): { runId: string; paths: RunPaths } {
  for (let attempt = 0; ; attempt++) {
    const runId = makeId();
    try {
      return { runId, paths: initRunDir(root, runId) };
    } catch (err) {
      if (attempt >= 4 || (err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
}

/** Create .sao/runs/<id>/logs under root and keep .sao/ out of git via .git/info/exclude. */
export function initRunDir(root: string, runId: string): RunPaths {
  const runsDir = join(root, ".sao", "runs");
  const dir = join(runsDir, runId);
  mkdirSync(runsDir, { recursive: true });
  mkdirSync(dir); // non-recursive: an existing dir (run-id collision) must throw, not merge
  const logsDir = join(dir, "logs");
  mkdirSync(logsDir);
  ensureGitExclude(root);
  return { dir, logsDir, stateFile: join(dir, "state.json") };
}

export function saveState(paths: RunPaths, state: RunState): void {
  // temp + rename: a crash mid-write must never leave a truncated state.json. The
  // temp name carries the pid: with a fixed name, two processes racing on one run
  // (a concurrent resume) ENOENT-crash on each other's rename.
  // Stryker disable next-line all: dropping the suffix turns write+rename into write+rename-onto-itself, which only degrades crash-atomicity — unobservable in-process
  const tmp = `${paths.stateFile}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
  renameSync(tmp, paths.stateFile);
}

/** Whether a pid is a live process (EPERM counts: it exists, we just can't signal it). */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

// Everything createRunId can emit (date stamp, sanitized slug, hex suffix). Doubles
// as a path-traversal guard: a run id becomes a path under .sao/runs, so a
// user-supplied id like "../../etc" must be rejected before any join().
const RUN_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

function runPaths(root: string, runId: string): RunPaths {
  const dir = join(root, ".sao", "runs", runId);
  return { dir, logsDir: join(dir, "logs"), stateFile: join(dir, "state.json") };
}

/** Load a persisted run by id (resume/logs). Throws on unknown ids and corrupt state. */
export function loadRun(root: string, runId: string): { state: RunState; paths: RunPaths } {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new SaoError(`invalid run id "${runId}"`, "run ids use only letters, digits, - and _ (see sao list)");
  }
  const paths = runPaths(root, runId);
  if (!existsSync(paths.stateFile)) {
    throw new SaoError(`run not found: ${runId}`, `sao list shows available runs (looked in ${paths.dir})`);
  }
  const state = readState(paths.stateFile);
  if (state === undefined) {
    throw new SaoError(`state.json for run ${runId} is corrupt`, `inspect it at ${paths.stateFile}`);
  }
  return { state, paths };
}

/** Parse a state.json; undefined when unreadable or not shaped like a run. */
function readState(stateFile: string): RunState | undefined {
  let parsed: unknown;
  try {
    // Stryker disable next-line StringLiteral: mutating "utf8" to "" yields a Buffer, which JSON.parse coerces via toString() (utf8) to the identical text
    parsed = JSON.parse(readFileSync(stateFile, "utf8"));
  } catch /* Stryker disable next-line all: equivalent — with the early return removed, `parsed` stays undefined and the typeof guard below returns undefined identically */ {
    return undefined;
  }
  if (parsed === null) return undefined; // typeof null is "object" — it would crash the field checks
  // Stryker disable next-line all: equivalent — every non-null primitive sails through to the field checks, where its undefined properties fail the very first typeof
  if (typeof parsed !== "object") return undefined;
  const state = parsed as RunState;
  // Everything list/resume dereference must be present — one malformed state.json
  // must degrade to a skipped entry, never break `sao list` for every run.
  if (
    // Stryker disable next-line ConditionalExpression: dropping the id type check is equivalent — the id-vs-directory equality below can never accept a non-string id (basename always returns a string)
    typeof state.id !== "string" ||
    typeof state.status !== "string" ||
    typeof state.workflow !== "string" ||
    typeof state.task !== "string" ||
    state.nodes === null ||
    typeof state.nodes !== "object" ||
    state.vars === null ||
    typeof state.vars !== "object"
  ) {
    return undefined;
  }
  // A tampered id re-aims every id-derived safety check (worktree layout, branch,
  // clean) at ANOTHER run's legitimate paths — the id must be the directory's.
  if (state.id !== basename(dirname(stateFile))) return undefined;
  // Backfill fields older (M1/M2) runs never wrote — type-checked, not just nullish:
  // a junk createdAt would crash the list sort for every run.
  if (typeof state.autoOpenPr !== "boolean") state.autoOpenPr = false;
  if (typeof state.createdAt !== "string") state.createdAt = statSync(stateFile).mtime.toISOString();
  return state;
}

const LOCK_FILE = "engine.lock";

/**
 * Atomic run ownership (O_EXCL lock file with the holder's pid): the status/pid
 * fields in state.json are check-then-write and two resumes racing through that
 * window both execute every node. Returns a release function (idempotent).
 * `takeover` (--force) reclaims even a live holder's lock.
 */
export function acquireRunLock(paths: RunPaths, takeover = false): () => void {
  const lockFile = join(paths.dir, LOCK_FILE);
  // Stryker disable next-line UpdateOperator: the counter only matters when a competitor recreates the lock between the rm below and the retry — a race no deterministic test can stage
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockFile, "wx");
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      return () => {
        // Stryker disable next-line ObjectLiteral: force only suppresses ENOENT — releasing twice (or after a crash cleanup) must stay a no-op
        rmSync(lockFile, { force: true });
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const holder = readLockPid(lockFile);
      // Stryker disable next-line ConditionalExpression: forcing the undefined-guard true is equivalent — isPidAlive(undefined) throws inside its try and reports dead
      if (holder !== undefined && isPidAlive(holder) && !takeover) {
        throw new SaoError(
          `run ${basename(paths.dir)} is locked by a live sao process (pid ${holder})`,
          "wait for it to finish; if you are certain it is gone, resume with --force",
        );
      }
      // Stryker disable next-line ObjectLiteral,BooleanLiteral: force only suppresses ENOENT when the stale lock vanishes between the failed open and this rm — a race
      rmSync(lockFile, { force: true }); // stale (or takeover) — reclaim and retry
    }
  }
  // Stryker disable next-line StringLiteral: reachable only through the same unstageable race as the loop counter above
  throw new SaoError(`run ${basename(paths.dir)} is being contended by another sao process`, "retry in a moment");
}

/** The pid of a live process holding this run's lock, if any. */
export function runLockHolder(paths: RunPaths): number | undefined {
  const holder = readLockPid(join(paths.dir, LOCK_FILE));
  // Stryker disable next-line ConditionalExpression: forcing the undefined-guard true is equivalent — isPidAlive(undefined) throws inside its try and reports dead
  return holder !== undefined && isPidAlive(holder) ? holder : undefined;
}

function readLockPid(lockFile: string): number | undefined {
  let raw: string;
  try {
    raw = readFileSync(lockFile, "utf8");
  } catch {
    return undefined; // vanished between existence check and read
  }
  // Stryker disable next-line MethodExpression: Number() already ignores surrounding whitespace — trim only aids readability
  const pid = Number(raw.trim());
  // pid > 0 matters: an empty file reads as 0, and kill(0, …) signals our own
  // process GROUP — "alive" forever, wedging the lock.
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

export interface RunListing {
  state: RunState;
  paths: RunPaths;
}

/** Every readable run under .sao/runs, newest first. Unparseable entries are skipped. */
export function listRuns(root: string): RunListing[] {
  const runsDir = join(root, ".sao", "runs");
  if (!existsSync(runsDir)) return [];
  const listings: RunListing[] = [];
  for (const entry of readdirSync(runsDir)) {
    if (!RUN_ID_PATTERN.test(entry)) continue;
    const paths = runPaths(root, entry);
    // Stryker disable next-line ConditionalExpression,BlockStatement: equivalent — readState returns undefined for an unreadable file anyway; this just skips the exception path
    if (!existsSync(paths.stateFile)) continue;
    const state = readState(paths.stateFile);
    if (state === undefined) continue;
    listings.push({ state, paths });
  }
  return listings.sort((a, b) => b.state.createdAt.localeCompare(a.state.createdAt));
}

/**
 * The MAIN working-tree root governing `start`: the closest ancestor containing a
 * `.git` entry — and when that entry is a file (a linked worktree, e.g. sao's own
 * `.sao/worktrees/<id>`), followed through gitdir/commondir to the main checkout.
 * Without the follow, every `sao` command run from inside a run's worktree would
 * look for `.sao/runs` in the worktree and see nothing. Falls back to `start`
 * outside any repo. Anchors repo-level lookups like `.agents/agents/<name>.md`.
 */
export function findRepoRoot(start: string): string {
  let dir = resolve(start);
  while (true) {
    const dotGit = join(dir, ".git");
    if (existsSync(dotGit)) {
      // Stryker disable next-line ConditionalExpression: forcing this false is equivalent — findGitDir resolves a plain .git directory to the same <dir>/.git, and the branch below then returns the same root; the early return only skips work
      if (statSync(dotGit).isDirectory()) return dir;
      const gitDir = findGitDir(dir); // follows gitdir + commondir
      // The common dir of a normal repo is <main-root>/.git; anything else
      // (submodule module dirs, bare setups) keeps the local answer.
      if (gitDir !== undefined && basename(gitDir) === ".git") return dirname(gitDir);
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) return resolve(start);
    dir = parent;
  }
}

/**
 * Locate the git directory governing `start`, walking up like git does. A `.git`
 * **file** (linked worktree, submodule) is followed to its real dir, then to the
 * common dir when one exists — info/exclude lives there.
 */
function findGitDir(start: string): string | undefined {
  let dir = resolve(start);
  while (true) {
    const dotGit = join(dir, ".git");
    if (existsSync(dotGit)) {
      if (statSync(dotGit).isDirectory()) return dotGit;
      // Stryker disable next-line StringLiteral: mutating "utf8" to "" makes readFileSync return a Buffer, which exec coerces via Buffer#toString() (utf8) to the identical string
      const match = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, "utf8"));
      // Stryker disable next-line all: with the check mutated away, a null match throws on match[1] below and is swallowed by ensureGitExclude's best-effort catch — observably identical
      if (!match) return undefined;
      const gitDir = resolve(dir, match[1]!);
      const commonFile = join(gitDir, "commondir");
      return existsSync(commonFile) ? resolve(gitDir, readFileSync(commonFile, "utf8").trim()) : gitDir;
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function ensureGitExclude(root: string): void {
  try {
    const gitDir = findGitDir(root);
    // Stryker disable next-line all: with the guard mutated away, join(undefined, "info") throws a TypeError before any filesystem write and is swallowed by the catch below — observably identical
    if (gitDir === undefined) return;
    const infoDir = join(gitDir, "info");
    const excludeFile = join(infoDir, "exclude");
    const current = existsSync(excludeFile) ? readFileSync(excludeFile, "utf8") : "";
    if (current.split("\n").some((line) => line.trim() === ".sao/")) return;
    mkdirSync(infoDir, { recursive: true });
    appendFileSync(excludeFile, (current.endsWith("\n") || current === "" ? "" : "\n") + ".sao/\n");
  } catch {
    // best-effort: a failed exclude write must never block a run
  }
}
