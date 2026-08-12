import { spawnSync } from "node:child_process";
import { mkdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { SaoError, truncateDetail } from "./errors";

/**
 * Git worktree lifecycle for run isolation (SPEC step 4): each run gets its own
 * worktree + branch cut from a base ref, kept until `sao clean`. All commands run
 * synchronously — worktree operations happen before and after node execution, never
 * concurrently with it.
 */

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

function git(args: string[], cwd: string, env?: Record<string, string>, timeoutMs?: number): GitResult {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...env }, timeout: timeoutMs });
  // Stryker disable next-line ConditionalExpression: forcing the flavor check true is test-equivalent — a black-holed remote (ETIMEDOUT) is the only result.error any in-process test can stage; the unspawnable-git flavors below are not fabricatable
  if (result.error && (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
    throw new SaoError(
      `git ${args[0]} timed out after ${timeoutMs}ms`,
      "the remote did not respond — check the network, then retry",
    );
  }
  // Stryker disable all: result.error means git itself could not be spawned (not
  // installed, or the cwd vanished). Bun resolves executables outside process.env.PATH,
  // so no in-process test can fabricate a missing git; the cwd-vanished flavor is
  // covered only through worktreeHasChanges' conservative catch.
  if (result.error) {
    throw new SaoError(
      `failed to run git: ${result.error.message}`,
      "worktree isolation needs git on PATH (--no-worktree skips it)",
    );
  }
  // The ?? fallbacks fire only on that same unspawnable-git path (null status when
  // killed by a signal, null streams on spawn failure) — callers see zero vs
  // non-zero and strings either way.
  return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}
// Stryker restore all — placed after the brace: a restore that is the last line
// inside a block attaches to nothing and silently disables the rest of the file.

function gitFailure(message: string, res: GitResult, hint?: string): SaoError {
  const detail = truncateDetail(res.stderr) ?? truncateDetail(res.stdout);
  return new SaoError(message, hint !== undefined && detail !== undefined ? `${detail}\n  ${hint}` : (detail ?? hint));
}

/** Fail fast when `root` is not inside a git repository (worktrees need one). */
export function requireGitRepo(root: string): void {
  const res = git(["rev-parse", "--is-inside-work-tree"], root);
  // Stryker disable next-line ConditionalExpression: dropping the exit-code clause is equivalent — a failing rev-parse prints nothing, so the stdout clause catches it; kept for clarity
  if (res.code !== 0 || res.stdout.trim() !== "true") {
    throw new SaoError(
      "not a git repository — worktree isolation needs one",
      "run inside a git repo, or pass --no-worktree to run in place",
    );
  }
}

/** Resolve the current HEAD to a commit SHA (the default base for new runs). */
export function resolveHead(root: string): string {
  const res = git(["rev-parse", "--verify", "HEAD^{commit}"], root);
  if (res.code !== 0) {
    throw new SaoError(
      "cannot resolve HEAD — does the repository have any commits?",
      "commit something first, or pass --no-worktree to run in place",
    );
  }
  return res.stdout.trim();
}

/** Verify a user-supplied base ref names a commit, before any run state exists. */
export function verifyBaseRef(root: string, ref: string): void {
  // Defense in depth: the ^{commit} suffix below already keeps option-shaped values
  // out of git's option parser, but a base is later passed BARE to `worktree add`.
  if (ref.startsWith("-")) {
    throw new SaoError(`invalid base ref: ${ref}`, "refs cannot start with '-' (git would parse it as an option)");
  }
  const res = git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], root);
  if (res.code !== 0) {
    throw gitFailure(`base ref not found: ${ref}`, res, "pass a branch, tag, or commit that exists in this repository");
  }
}

/**
 * Reject option-shaped or malformed branch names before they reach git argv.
 * `git worktree add … -b <branch>` does NOT protect -b's value: `--branch=-f` would
 * be consumed as --force and the next word taken as the branch name — observed to
 * force-move an existing branch (data loss). check-ref-format is safe to call
 * because the value is concatenated into `refs/heads/…`, never a bare argument.
 */
export function validateBranchName(root: string, branch: string): void {
  if (branch.startsWith("-")) {
    throw new SaoError(
      `invalid branch name: ${branch}`,
      "branch names cannot start with '-' (git would parse it as an option)",
    );
  }
  // check-ref-format ACCEPTS "+x", but to `git push` a leading '+' means force —
  // a branch named "+main" would silently force-push over origin/main.
  if (branch.startsWith("+")) {
    throw new SaoError(
      `invalid branch name: ${branch}`,
      "branch names cannot start with '+' (git push would read it as a force refspec)",
    );
  }
  const res = git(["check-ref-format", `refs/heads/${branch}`], root);
  if (res.code !== 0) {
    throw new SaoError(`invalid branch name: ${branch}`, "git check-ref-format rejected it");
  }
}

/** Reject a user-supplied branch name that already exists (worktree add uses -b). */
export function verifyBranchIsNew(root: string, branch: string): void {
  const res = git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], root);
  if (res.code === 0) {
    throw new SaoError(
      `branch already exists: ${branch}`,
      "pick another --branch name, or delete the existing branch first",
    );
  }
}

/** Whether a local branch exists right now. */
export function branchExists(root: string, branch: string): boolean {
  return git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], root).code === 0;
}

/**
 * `git worktree add <path> -b <branch> <base>` — the run's isolated checkout.
 * On failure the branch is cleaned up ONLY if it did not exist immediately before
 * the add: unwinding unconditionally would `-D` a pre-existing branch that merely
 * collided (TOCTOU past verifyBranchIsNew, or an unlucky sao/<id> name).
 */
export function addWorktree(root: string, worktreePath: string, branch: string, base: string): void {
  try {
    mkdirSync(dirname(worktreePath), { recursive: true });
  } catch (err) {
    // e.g. something non-directory squatting on .sao/worktrees — a SaoError keeps
    // the CLI's formatted error path instead of a raw stack.
    throw new SaoError(`cannot create ${dirname(worktreePath)}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const branchPreExisted = branchExists(root, branch);
  const res = git(["worktree", "add", worktreePath, "-b", branch, base], root);
  if (res.code !== 0) {
    if (!branchPreExisted) deleteBranch(root, branch); // git can leave the new branch behind on a failed add
    throw gitFailure(`git worktree add failed (exit ${res.code})`, res);
  }
}

/**
 * Commit any uncommitted changes in the worktree as `sao: finalize run <id>`
 * (SPEC step 8). Returns whether a commit was made. Throws on git failure —
 * callers downgrade that to a warning; a failed finalize must not fail the run.
 */
export function finalizeWorktree(worktreePath: string, runId: string): boolean {
  const status = git(["status", "--porcelain"], worktreePath);
  if (status.code !== 0) throw gitFailure("git status failed in the worktree", status);
  // Stryker disable next-line MethodExpression: equivalent — porcelain output is empty or substantive, never whitespace-only, so trim() cannot change the emptiness verdict
  if (!status.stdout.trim()) return false;
  const add = git(["add", "-A"], worktreePath);
  if (add.code !== 0) throw gitFailure("git add failed in the worktree", add);
  // gpgsign off: this is sao's bookkeeping commit, and a locked signing key would
  // hang the (unbounded) spawnSync forever — on every finalize retry. Hooks off for
  // the same reason: a blocking/interactive pre-commit (or any other) hook hangs
  // identically. hooksPath aimed at a non-directory disables every hook, not just
  // the pair --no-verify covers.
  const commit = git(
    ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "-m", `sao: finalize run ${runId}`],
    worktreePath,
  );
  if (commit.code !== 0) {
    throw gitFailure("finalize commit failed", commit, "is git user.name/user.email configured?");
  }
  return true;
}

/**
 * Whether the path is a FUNCTIONING worktree whose own root is the path itself.
 * A SIGKILL exactly mid-`git worktree add` can leave a husk directory; because it
 * sits inside the main repo, `is-inside-work-tree` would happily say "true" — the
 * toplevel comparison is what tells "this dir IS a worktree" from "this dir is
 * junk inside one".
 */
export function isUsableWorktree(worktreePath: string): boolean {
  try {
    const res = git(["rev-parse", "--show-toplevel"], worktreePath);
    // Stryker disable next-line ConditionalExpression: dropping the guard is equivalent — a failing rev-parse prints no toplevel, so the realpath comparison below fails identically
    if (res.code !== 0) return false;
    return realpathSync(worktreePath) === res.stdout.trim(); // git prints realpaths
  } catch {
    return false; // missing dir, unreadable, git unspawnable — all unusable
  }
}

/** Whether the worktree has uncommitted changes. Conservative: unreadable = dirty. */
export function worktreeHasChanges(worktreePath: string): boolean {
  try {
    const res = git(["status", "--porcelain"], worktreePath);
    // Stryker disable next-line MethodExpression: equivalent — porcelain output is empty or substantive, never whitespace-only, so trim() cannot change the emptiness verdict
    return res.code !== 0 || res.stdout.trim() !== "";
  } catch {
    return true; // can't even spawn git there (missing dir, …): treat as dirty
  }
}

/** `git worktree remove --force` — discards uncommitted changes by design (sao clean). */
export function removeWorktree(root: string, worktreePath: string): void {
  const res = git(["worktree", "remove", "--force", worktreePath], root);
  if (res.code !== 0) throw gitFailure(`git worktree remove failed: ${worktreePath}`, res);
}

/**
 * Whether the branch's tip is reachable from some OTHER ref — i.e. deleting the
 * branch loses no commits. Conservative: unreadable/missing branch = not merged.
 */
export function branchIsMergedElsewhere(root: string, branch: string): boolean {
  // Stryker disable next-line ConditionalExpression,MethodExpression: security invariant, same as deleteBranch's guard — git happens to reject every option-shaped value we can safely test, so mutating the guard is outcome-equivalent yet it must stay
  if (branch.startsWith("-")) return false;
  const res = git(["branch", "--format=%(refname:short)", "--contains", branch], root);
  // Stryker disable next-line ConditionalExpression: equivalent — a failing `git branch --contains` prints nothing, so the parse below yields not-merged anyway
  if (res.code !== 0) return false;
  // No trim: --format=%(refname:short) emits bare names, one per line, and the
  // empty-string guard drops the trailing newline's empty element.
  return res.stdout.split("\n").some((name) => name !== "" && name !== branch);
}

/** Force-delete a run branch; false when git refuses (already gone, checked out, …). */
export function deleteBranch(root: string, branch: string): boolean {
  // state.branch is only as trustworthy as state.json — never let an option-shaped
  // value reach `git branch` argv.
  // Stryker disable next-line ConditionalExpression: the guard is a security invariant — git itself rejects every option-shaped name we can safely test, so removing it is outcome-equivalent yet must stay
  if (branch.startsWith("-")) return false;
  return git(["branch", "-D", branch], root).code === 0;
}

/** Best-effort `git worktree prune` after clean; failures are ignored. */
// Stryker disable all: housekeeping — worktree remove already deregisters its entry, so pruning (or not, or with junk argv that git rejects) is unobservable
export function pruneWorktrees(root: string): void {
  git(["worktree", "prune"], root);
}
// Stryker restore all

/**
 * Push the run branch to origin (--auto-open-pr, SPEC step 8). Throws on failure —
 * the engine downgrades that to a warning plus the default report; the run stays
 * succeeded either way.
 */
export function pushBranch(worktreePath: string, branch: string, timeoutMs: number = PUSH_TIMEOUT_MS): void {
  // state.branch is only as trustworthy as state.json. To `git push` a bare name is
  // REFSPEC syntax: "+x" force-pushes and "src:dst" redirects to another ref — a
  // tampered branch of "+sao/x:main" would force-overwrite origin/main and report
  // success. Full validation (option shape, '+', ':' via check-ref-format) first…
  validateBranchName(worktreePath, branch);
  // …and an explicit src:dst refspec second, so no character of the name can ever
  // reach git's refspec parser as syntax.
  const refspec = `refs/heads/${branch}:refs/heads/${branch}`;
  // GIT_TERMINAL_PROMPT=0: a credential prompt would hang spawnSync (same rationale
  // as finalize's gpgsign/hooks) — fail fast instead. The timeout bounds the network
  // vector: a black-holed remote must not strand a finished run as "running" forever.
  // Stryker disable next-line ObjectLiteral,StringLiteral: only observable against a credential-prompting remote — no local test can stage an interactive git prompt
  const res = git(["push", "--set-upstream", "origin", refspec], worktreePath, { GIT_TERMINAL_PROMPT: "0" }, timeoutMs);
  if (res.code !== 0) {
    throw gitFailure(`git push failed for ${branch}`, res, "is an 'origin' remote configured and writable?");
  }
}

// Generous for a big first push, but bounded: all nodes already succeeded by the
// time sao pushes, and a hang here strands the run as "running" forever.
const PUSH_TIMEOUT_MS = 120_000;

/**
 * `gh pr create --draft` in the run worktree; returns the PR URL gh prints.
 * Title/branch use --flag=value form (a leading "-" can then never open a new flag);
 * the body rides over stdin — it is arbitrary AI output: unbounded and untrusted.
 */
export function createDraftPr(
  worktreePath: string,
  opts: { branch: string; title: string; body: string; baseBranch?: string },
  timeoutMs: number = PUSH_TIMEOUT_MS,
): string {
  // Same trust model as pushBranch: state.json values never reach argv unvalidated.
  validateBranchName(worktreePath, opts.branch);
  const args = ["pr", "create", "--draft", `--head=${opts.branch}`, `--title=${opts.title}`, "--body-file", "-"];
  if (opts.baseBranch !== undefined) {
    validateBranchName(worktreePath, opts.baseBranch);
    args.push(`--base=${opts.baseBranch}`);
  }
  const result = spawnSync("gh", args, {
    cwd: worktreePath,
    encoding: "utf8",
    input: opts.body,
    // Bounded for the same reason as the push: a gh stalled on a black-holed API
    // must not strand a finished run as "running" forever.
    timeout: timeoutMs,
    // GH_PROMPT_DISABLED: gh must fail fast, not interview a terminal nobody is watching.
    // Stryker disable next-line StringLiteral: only observable against an interactively-prompting gh — no local test can stage one
    env: { ...process.env, GH_PROMPT_DISABLED: "1" },
  });
  // Stryker disable next-line ConditionalExpression: forcing the flavor check true is test-equivalent — a hung stub (ETIMEDOUT) is the only result.error any in-process test can stage; unspawnable-gh flavors are not fabricatable
  if (result.error && (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
    throw new SaoError(
      `gh pr create timed out after ${timeoutMs}ms`,
      "GitHub did not respond — open the PR manually with: gh pr create",
    );
  }
  // Stryker disable all: result.error means gh itself could not be spawned. Bun falls
  // back to system paths when the mutated PATH misses, so no in-process test can
  // fabricate a missing gh (same reasoning as git() above).
  if (result.error) {
    throw new SaoError(
      `failed to run gh: ${result.error.message}`,
      "install the GitHub CLI: https://cli.github.com (or drop --auto-open-pr)",
    );
  }
  // Stryker restore all — placed after the brace: a restore that is the last line
  // inside a block attaches to nothing and silently disables the rest of the file.
  if (result.status !== 0) {
    throw gitFailure(
      "gh pr create failed",
      // Stryker disable next-line all: the ?? fallbacks fire only when gh is killed by a signal (null status/streams) — not stageable deterministically, and every substitute value still lands in the same thrown error
      { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" },
      "is gh authenticated (gh auth status), and does the repo have an 'origin' on GitHub?",
    );
  }
  // gh prints the PR URL on stdout, possibly among notices — take the last line that
  // IS a URL, and treat none as a failure (the engine then falls back to the manual
  // hint instead of printing a notice line as if it were the PR).
  // Stryker disable next-line StringLiteral: the ?? fallback fires only when gh is killed by a signal (null stdout) — not stageable deterministically
  const lines = (result.stdout ?? "").split("\n").map((line) => line.trim());
  const url = lines.filter((line) => /^https?:\/\//.test(line)).pop();
  if (url === undefined) {
    throw new SaoError(
      "gh pr create printed no PR URL",
      truncateDetail(result.stdout) ?? "open the PR manually with: gh pr create",
    );
  }
  return url;
}

/** Where a run's worktree lives, relative to the repo root (stored in state.json). */
export function worktreeRelPath(runId: string): string {
  return join(".sao", "worktrees", runId);
}
