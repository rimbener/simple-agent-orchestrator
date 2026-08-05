import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SaoError } from "../src/errors";
import {
  addWorktree,
  branchExists,
  branchIsMergedElsewhere,
  deleteBranch,
  finalizeWorktree,
  isUsableWorktree,
  pruneWorktrees,
  removeWorktree,
  requireGitRepo,
  resolveHead,
  validateBranchName,
  verifyBaseRef,
  verifyBranchIsNew,
  worktreeHasChanges,
  worktreeRelPath,
} from "../src/worktree";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** Fresh git repo on branch main with one commit. */
function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "sao-wt-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "T");
  writeFileSync(join(dir, "seed.txt"), "seed\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "init");
  return dir;
}

function bareDir(): string {
  return mkdtempSync(join(tmpdir(), "sao-nowt-"));
}

describe("requireGitRepo / resolveHead", () => {
  test("passes inside a repo, throws outside with the --no-worktree hint", () => {
    expect(() => requireGitRepo(repo())).not.toThrow();
    try {
      requireGitRepo(bareDir());
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SaoError);
      expect((err as SaoError).message).toBe("not a git repository — worktree isolation needs one");
      expect((err as SaoError).hint).toContain("--no-worktree");
    }
  });

  test("a bare repository is refused too — worktree add needs a working tree", () => {
    const dir = bareDir();
    git(dir, "init", "-q", "--bare");
    expect(() => requireGitRepo(dir)).toThrow("not a git repository — worktree isolation needs one");
  });


  test("resolveHead returns the HEAD commit SHA", () => {
    const dir = repo();
    expect(resolveHead(dir)).toBe(git(dir, "rev-parse", "HEAD"));
    expect(resolveHead(dir)).toMatch(/^[0-9a-f]{40}$/);
  });

  test("resolveHead on a repo with no commits explains itself", () => {
    const dir = bareDir();
    git(dir, "init", "-q", "-b", "main");
    try {
      resolveHead(dir);
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as SaoError).message).toContain("cannot resolve HEAD");
      expect((err as SaoError).hint).toContain("--no-worktree");
    }
  });
});

describe("verifyBaseRef", () => {
  test("accepts branches, tags, and SHAs", () => {
    const dir = repo();
    git(dir, "tag", "v1");
    expect(() => verifyBaseRef(dir, "main")).not.toThrow();
    expect(() => verifyBaseRef(dir, "v1")).not.toThrow();
    expect(() => verifyBaseRef(dir, git(dir, "rev-parse", "HEAD"))).not.toThrow();
  });

  test("rejects unknown refs with a hint", () => {
    try {
      verifyBaseRef(repo(), "ghost");
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as SaoError).message).toBe("base ref not found: ghost");
      // Exact: rev-parse --quiet prints no stderr, so the hint must be the caller's
      // alone — never "undefined" glued to it by a broken composition.
      expect((err as SaoError).hint).toBe("pass a branch, tag, or commit that exists in this repository");
    }
  });

  test("rejects option-shaped refs before they can reach git argv", () => {
    for (const ref of ["-q", "--all", "--upload-pack=/bin/sh"]) {
      try {
        verifyBaseRef(repo(), ref);
        throw new Error("should have thrown");
      } catch (err) {
        expect((err as SaoError).message).toBe(`invalid base ref: ${ref}`);
        expect((err as SaoError).hint).toContain("cannot start with '-'");
      }
    }
  });
});

describe("validateBranchName", () => {
  test("rejects option-shaped names — git would consume them as flags", () => {
    // --branch=-f was observed to force-move an existing branch (git took -f as
    // --force and the base as the branch name). Must die before any git call.
    for (const branch of ["-f", "-B", "--force", "-t"]) {
      try {
        validateBranchName(repo(), branch);
        throw new Error("should have thrown");
      } catch (err) {
        expect((err as SaoError).message).toBe(`invalid branch name: ${branch}`);
        expect((err as SaoError).hint).toContain("cannot start with '-'");
      }
    }
  });

  test("rejects names check-ref-format refuses", () => {
    for (const branch of ["a..b", "a b", "a.lock", "end/"]) {
      try {
        validateBranchName(repo(), branch);
        throw new Error("should have thrown");
      } catch (err) {
        expect((err as SaoError).message).toBe(`invalid branch name: ${branch}`);
        expect((err as SaoError).hint).toBe("git check-ref-format rejected it");
      }
    }
  });

  test("accepts ordinary and slashed names", () => {
    const dir = repo();
    expect(() => validateBranchName(dir, "feature-x")).not.toThrow();
    expect(() => validateBranchName(dir, "sao/2026-08-05-run")).not.toThrow();
  });
});

describe("verifyBranchIsNew", () => {
  test("throws for an existing branch, passes for a new one", () => {
    const dir = repo();
    expect(() => verifyBranchIsNew(dir, "fresh")).not.toThrow();
    try {
      verifyBranchIsNew(dir, "main");
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as SaoError).message).toBe("branch already exists: main");
      expect((err as SaoError).hint).toContain("--branch");
    }
  });
});

describe("addWorktree / removeWorktree / deleteBranch", () => {
  test("creates the worktree on a new branch cut from the base", () => {
    const dir = repo();
    const first = git(dir, "rev-parse", "HEAD");
    writeFileSync(join(dir, "second.txt"), "2\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "second");
    const wt = join(dir, ".sao", "worktrees", "run-1");
    addWorktree(dir, wt, "sao/run-1", first);
    expect(existsSync(join(wt, "seed.txt"))).toBe(true);
    expect(existsSync(join(wt, "second.txt"))).toBe(false); // cut from the FIRST commit
    expect(git(wt, "rev-parse", "--abbrev-ref", "HEAD")).toBe("sao/run-1");
    expect(git(wt, "rev-parse", "HEAD")).toBe(first);
  });

  test("a failed add surfaces git's stderr as the hint and unwinds the branch it created", () => {
    const dir = repo();
    const wt = join(dir, ".sao", "worktrees", "run-x");
    addWorktree(dir, wt, "sao/run-x", "main");
    try {
      addWorktree(dir, wt, "sao/run-y", "main"); // path already in use
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as SaoError).message).toContain("git worktree add failed");
      expect((err as SaoError).hint).toContain("fatal:"); // git's stderr, verbatim
      // No caller hint here — nothing may glue "undefined" onto the detail.
      expect((err as SaoError).hint).not.toContain("undefined");
    }
    expect(branchExists(dir, "sao/run-y")).toBe(false); // the fresh branch was cleaned up
  });

  test("a failed add never deletes a branch that existed before it", () => {
    const dir = repo();
    git(dir, "branch", "victim");
    const victimTip = git(dir, "rev-parse", "victim");
    const wt = join(dir, ".sao", "worktrees", "run-v");
    expect(() => addWorktree(dir, wt, "victim", "main")).toThrow("git worktree add failed"); // -b collides
    expect(branchExists(dir, "victim")).toBe(true); // unwinding it would have lost the ref
    expect(git(dir, "rev-parse", "victim")).toBe(victimTip);
  });

  test("removeWorktree drops the checkout; deleteBranch drops the branch", () => {
    const dir = repo();
    const wt = join(dir, ".sao", "worktrees", "run-2");
    addWorktree(dir, wt, "sao/run-2", "main");
    removeWorktree(dir, wt);
    expect(existsSync(wt)).toBe(false);
    expect(deleteBranch(dir, "sao/run-2")).toBe(true);
    expect(git(dir, "branch", "--list", "sao/run-2")).toBe("");
    expect(() => pruneWorktrees(dir)).not.toThrow();
  });

  test("removeWorktree on a non-worktree dir throws instead of deleting blindly", () => {
    const dir = repo();
    expect(() => removeWorktree(dir, join(dir, "seed-dir-that-is-not-a-worktree"))).toThrow("git worktree remove failed");
  });

  test("deleteBranch is false for missing and option-shaped names", () => {
    const dir = repo();
    expect(deleteBranch(dir, "never-existed")).toBe(false);
    expect(deleteBranch(dir, "-D")).toBe(false); // never reaches git argv
    expect(deleteBranch(dir, "--all")).toBe(false);
  });

  test("the option guard checks the START of the name — a trailing dash is a real branch", () => {
    const dir = repo();
    git(dir, "branch", "x-");
    expect(deleteBranch(dir, "x-")).toBe(true);
    expect(git(dir, "branch", "--list", "x-")).toBe("");
  });
});

describe("finalizeWorktree / worktreeHasChanges", () => {
  test("commits uncommitted changes with the run-id message; false when clean", () => {
    const dir = repo();
    const wt = join(dir, ".sao", "worktrees", "run-3");
    addWorktree(dir, wt, "sao/run-3", "main");
    expect(worktreeHasChanges(wt)).toBe(false);
    expect(finalizeWorktree(wt, "run-3")).toBe(false); // nothing to commit
    writeFileSync(join(wt, "made.txt"), "output\n");
    expect(worktreeHasChanges(wt)).toBe(true);
    expect(finalizeWorktree(wt, "run-3")).toBe(true);
    expect(git(wt, "log", "-1", "--format=%s")).toBe("sao: finalize run run-3");
    expect(worktreeHasChanges(wt)).toBe(false);
  });

  test("finalize ignores repository hooks — a blocking pre-commit cannot fail (or hang) it", () => {
    const dir = repo();
    const wt = join(dir, ".sao", "worktrees", "run-hook");
    addWorktree(dir, wt, "sao/run-hook", "main");
    const hooksDir = git(wt, "rev-parse", "--path-format=absolute", "--git-path", "hooks");
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(join(hooksDir, "pre-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    expect(() => git(wt, "commit", "--allow-empty", "-m", "control")).toThrow(); // hook armed: plain commits are blocked
    writeFileSync(join(wt, "made.txt"), "output\n");
    expect(finalizeWorktree(wt, "run-hook")).toBe(true);
    expect(git(wt, "log", "-1", "--format=%s")).toBe("sao: finalize run run-hook");
  });

  test("worktreeHasChanges is conservative on unreadable paths", () => {
    expect(worktreeHasChanges(join(bareDir(), "nope"))).toBe(true);
  });

  test("worktreeHasChanges is conservative when git runs but fails (corrupt worktree)", () => {
    const dir = repo();
    const wt = join(dir, ".sao", "worktrees", "run-dirtyfail");
    addWorktree(dir, wt, "sao/run-dirtyfail", "main");
    writeFileSync(join(wt, ".git"), "gitdir: /nonexistent-gitdir\n");
    // git status exits non-zero with empty stdout — that must read as dirty.
    expect(worktreeHasChanges(wt)).toBe(true);
  });

  test("a broken git identity fails the commit with detail AND hint composed", () => {
    const dir = repo();
    const wt = join(dir, ".sao", "worktrees", "run-ident");
    addWorktree(dir, wt, "sao/run-ident", "main");
    writeFileSync(join(wt, "work.txt"), "x\n");
    git(dir, "config", "user.name", "");
    git(dir, "config", "user.email", "");
    try {
      finalizeWorktree(wt, "run-ident");
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as SaoError).message).toBe("finalize commit failed");
      // gitFailure composes stderr detail + caller hint — both must survive.
      expect((err as SaoError).hint).toContain("ident");
      expect((err as SaoError).hint).toContain("is git user.name/user.email configured?");
    }
  });

  test("a locked index fails the add step with its own message", () => {
    const dir = repo();
    const wt = join(dir, ".sao", "worktrees", "run-lock");
    addWorktree(dir, wt, "sao/run-lock", "main");
    writeFileSync(join(wt, "work.txt"), "x\n");
    const indexPath = git(wt, "rev-parse", "--path-format=absolute", "--git-path", "index");
    writeFileSync(`${indexPath}.lock`, "");
    try {
      finalizeWorktree(wt, "run-lock");
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as SaoError).message).toBe("git add failed in the worktree");
    }
  });

  test("a corrupted worktree fails the status step with its own message", () => {
    const dir = repo();
    const wt = join(dir, ".sao", "worktrees", "run-corrupt");
    addWorktree(dir, wt, "sao/run-corrupt", "main");
    writeFileSync(join(wt, ".git"), "gitdir: /nonexistent-gitdir\n");
    try {
      finalizeWorktree(wt, "run-corrupt");
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as SaoError).message).toBe("git status failed in the worktree");
    }
  });
});

describe("isUsableWorktree", () => {
  test("true only for a functioning worktree whose own root is the path", () => {
    const dir = repo();
    const wt = join(dir, ".sao", "worktrees", "run-usable");
    addWorktree(dir, wt, "sao/run-usable", "main");
    expect(isUsableWorktree(wt)).toBe(true);
    expect(isUsableWorktree(join(dir, ".sao", "worktrees", "never-made"))).toBe(false); // missing
    expect(isUsableWorktree(bareDir())).toBe(false); // exists, but outside any repo
  });

  test("a SIGKILL-mid-add husk directory inside the repo is NOT usable", () => {
    // The husk sits inside the main repo, so is-inside-work-tree would say "true";
    // only the toplevel comparison catches that the dir itself is not a worktree.
    const dir = repo();
    const husk = join(dir, ".sao", "worktrees", "run-husk");
    mkdirSync(husk, { recursive: true });
    expect(isUsableWorktree(husk)).toBe(false);
    // And the main checkout itself IS its own toplevel:
    expect(isUsableWorktree(dir)).toBe(true);
  });
});

describe("branchExists / branchIsMergedElsewhere", () => {
  test("branchExists tracks creation and deletion", () => {
    const dir = repo();
    expect(branchExists(dir, "feat")).toBe(false);
    git(dir, "branch", "feat");
    expect(branchExists(dir, "feat")).toBe(true);
  });

  test("a branch is merged only when its tip is reachable from another ref", () => {
    const dir = repo();
    git(dir, "branch", "same-tip"); // no commits of its own → main contains it
    expect(branchIsMergedElsewhere(dir, "same-tip")).toBe(true);

    git(dir, "checkout", "-qb", "ahead");
    writeFileSync(join(dir, "extra.txt"), "x\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "ahead work");
    git(dir, "checkout", "-q", "main");
    expect(branchIsMergedElsewhere(dir, "ahead")).toBe(false); // deleting it loses the commit
    git(dir, "merge", "-q", "ahead");
    expect(branchIsMergedElsewhere(dir, "ahead")).toBe(true);
  });

  test("missing and option-shaped branches read as not merged", () => {
    const dir = repo();
    expect(branchIsMergedElsewhere(dir, "ghost")).toBe(false);
    expect(branchIsMergedElsewhere(dir, "--all")).toBe(false);
  });
});

describe("worktreeRelPath", () => {
  test("is the .sao/worktrees layout used everywhere", () => {
    expect(worktreeRelPath("run-9")).toBe(join(".sao", "worktrees", "run-9"));
  });
});
