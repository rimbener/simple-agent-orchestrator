import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

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
  startedAt?: string;
  endedAt?: string;
}

export interface RunState {
  id: string;
  workflow: string;
  workflowHash: string;
  task: string;
  vars: Record<string, string>;
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
  // temp + rename: a crash mid-write must never leave a truncated state.json
  // Stryker disable next-line all: dropping the ".tmp" suffix turns write+rename into write+rename-onto-itself, which only degrades crash-atomicity — unobservable in-process
  const tmp = paths.stateFile + ".tmp";
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
  renameSync(tmp, paths.stateFile);
}

/**
 * The working-tree root governing `start`: the closest ancestor containing a `.git`
 * entry (dir or file). Falls back to `start` outside any repo. Anchors repo-level
 * lookups like `.agents/agents/<name>.md`, so running sao from a subdirectory
 * resolves the same files as running it from the root.
 */
export function findRepoRoot(start: string): string {
  let dir = resolve(start);
  while (true) {
    if (existsSync(join(dir, ".git"))) return dir;
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
