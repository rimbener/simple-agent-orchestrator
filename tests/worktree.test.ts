import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SaoError } from "../src/errors";
import {
  addWorktree,
  branchExists,
  branchIsMergedElsewhere,
  createDraftPr,
  deleteBranch,
  finalizeWorktree,
  isUsableWorktree,
  pushBranch,
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

describe("pushBranch / createDraftPr", () => {
  /** Fake `gh` first on PATH recording argv + stdin; prints noise then a URL. */
  function withStubGh(script?: string): { dir: string; restore: () => void } {
    const dir = mkdtempSync(join(tmpdir(), "sao-gh-stub-"));
    writeFileSync(
      join(dir, "gh"),
      script ??
        `#!/bin/sh
printf '%s\\n' "$@" > "${join(dir, "args.txt")}"
cat > "${join(dir, "body.txt")}"
echo "some gh noise first"
echo ""
echo "https://github.com/o/r/pull/12"
`,
    );
    chmodSync(join(dir, "gh"), 0o755);
    const oldPath = process.env.PATH;
    process.env.PATH = `${dir}:${oldPath}`;
    return { dir, restore: () => (process.env.PATH = oldPath) };
  }

  function repoWithOrigin(): { dir: string; bare: string; wt: string } {
    const dir = repo();
    const bare = bareDir();
    git(bare, "init", "-q", "--bare");
    git(dir, "remote", "add", "origin", bare);
    const wt = join(dir, ".sao", "worktrees", "run-pr");
    addWorktree(dir, wt, "sao/run-pr", "main");
    return { dir, bare, wt };
  }

  test("pushBranch lands the branch on origin with an upstream", () => {
    const { bare, wt } = repoWithOrigin();
    pushBranch(wt, "sao/run-pr");
    expect(git(bare, "branch", "--list", "sao/run-pr")).toContain("sao/run-pr");
    expect(git(wt, "rev-parse", "--abbrev-ref", "sao/run-pr@{upstream}")).toBe("origin/sao/run-pr");
  });

  test("pushBranch without an origin composes detail and the remote hint", () => {
    const dir = repo();
    const wt = join(dir, ".sao", "worktrees", "run-nopush");
    addWorktree(dir, wt, "sao/run-nopush", "main");
    try {
      pushBranch(wt, "sao/run-nopush");
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as SaoError).message).toBe("git push failed for sao/run-nopush");
      expect((err as SaoError).hint).toContain("is an 'origin' remote configured and writable?");
    }
  });

  test("option-shaped and refspec-shaped branch names never reach git/gh argv", () => {
    const { wt } = repoWithOrigin();
    try {
      pushBranch(wt, "--force");
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as SaoError).message).toBe("invalid branch name: --force");
      expect((err as SaoError).hint).toBe("branch names cannot start with '-' (git would parse it as an option)");
    }
    // "+x" is check-ref-format-valid but means FORCE to git push's refspec parser —
    // "+sao/x:main" from a tampered state.json would force-overwrite origin/main.
    try {
      pushBranch(wt, "+main");
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as SaoError).message).toBe("invalid branch name: +main");
      expect((err as SaoError).hint).toBe("branch names cannot start with '+' (git push would read it as a force refspec)");
    }
    expect(() => pushBranch(wt, "sao/x:main")).toThrow("invalid branch name: sao/x:main"); // ':' via check-ref-format
    expect(() => createDraftPr(wt, { branch: "-f", title: "t", body: "b" })).toThrow("invalid branch name: -f");
    expect(() => createDraftPr(wt, { branch: "+main", title: "t", body: "b" })).toThrow("invalid branch name: +main");
    expect(() => createDraftPr(wt, { branch: "sao/run-pr", title: "t", body: "b", baseBranch: "-D" })).toThrow("invalid branch name: -D");
  });

  test("validateBranchName rejects '+…' at creation time too", () => {
    const dir = repo();
    expect(() => validateBranchName(dir, "+main")).toThrow("invalid branch name: +main");
  });

  test("the push uses an explicit refspec — a branch literally named like a ref pushes to itself", () => {
    // With a bare-name push, refspec syntax in the name is what makes "+x" dangerous;
    // the explicit refs/heads/x:refs/heads/x form pins both ends.
    const { bare, wt } = repoWithOrigin();
    pushBranch(wt, "sao/run-pr");
    expect(git(bare, "for-each-ref", "--format=%(refname)", "refs/heads/")).toBe("refs/heads/sao/run-pr");
  });

  test("a push to a black-holed remote times out instead of hanging forever", async () => {
    const dir = repo();
    const wt = join(dir, ".sao", "worktrees", "run-hang");
    addWorktree(dir, wt, "sao/run-hang", "main");
    // A TCP listener that accepts and never speaks — git blocks on the protocol.
    const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    git(dir, "remote", "add", "origin", `git://127.0.0.1:${server.port}/x.git`);
    try {
      pushBranch(wt, "sao/run-hang", 500);
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as SaoError).message).toBe("git push timed out after 500ms");
      expect((err as SaoError).hint).toContain("the remote did not respond");
    } finally {
      server.stop(true);
    }
  }, 15000);

  test("createDraftPr sends the body over stdin, flags as single tokens, and returns the URL", () => {
    const { wt } = repoWithOrigin();
    const gh = withStubGh();
    try {
      pushBranch(wt, "sao/run-pr");
      const url = createDraftPr(wt, {
        branch: "sao/run-pr",
        title: "-starts with a dash: still one token",
        body: "line one\nline two",
      });
      expect(url).toBe("https://github.com/o/r/pull/12");
      const args = readFileSync(join(gh.dir, "args.txt"), "utf8").split("\n");
      expect(args).toEqual(["pr", "create", "--draft", "--head=sao/run-pr", "--title=-starts with a dash: still one token", "--body-file", "-", ""]);
      expect(readFileSync(join(gh.dir, "body.txt"), "utf8")).toBe("line one\nline two");
    } finally {
      gh.restore();
    }
  });

  test("a baseBranch lands as --base=, after the same validation as the head", () => {
    const { wt } = repoWithOrigin();
    const gh = withStubGh();
    try {
      createDraftPr(wt, { branch: "sao/run-pr", title: "t", body: "b", baseBranch: "release-1.2" });
      const args = readFileSync(join(gh.dir, "args.txt"), "utf8").split("\n");
      expect(args).toContain("--base=release-1.2");
    } finally {
      gh.restore();
    }
  });

  test("the URL is the last line that IS a URL — trailing gh notices don't leak into the report", () => {
    const { wt } = repoWithOrigin();
    const gh = withStubGh(`#!/bin/sh
cat > /dev/null
echo "https://github.com/o/r/pull/13   "
echo "! a post-create notice"
echo "   "
`);
    try {
      expect(createDraftPr(wt, { branch: "sao/run-pr", title: "t", body: "b" })).toBe("https://github.com/o/r/pull/13");
    } finally {
      gh.restore();
    }
  });

  test("a gh that prints no URL is a failure, not an empty pr line", () => {
    const gh = withStubGh("#!/bin/sh\ncat > /dev/null\necho 'created something, silently'\n");
    const { wt } = repoWithOrigin();
    try {
      createDraftPr(wt, { branch: "sao/run-pr", title: "t", body: "b" });
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as SaoError).message).toBe("gh pr create printed no PR URL");
      expect((err as SaoError).hint).toContain("created something, silently");
    } finally {
      gh.restore();
    }
  });

  test("the URL match is anchored and scheme-flexible", () => {
    const { wt } = repoWithOrigin();
    // A trailing notice MENTIONING a URL mid-line must not be mistaken for the URL…
    const noisy = withStubGh(`#!/bin/sh
cat > /dev/null
echo "http://github.local/o/r/pull/14"
echo "note: see https://docs.github.com for draft PRs"
`);
    try {
      // …and a plain-http URL (GH Enterprise) still matches.
      expect(createDraftPr(wt, { branch: "sao/run-pr", title: "t", body: "b" })).toBe("http://github.local/o/r/pull/14");
    } finally {
      noisy.restore();
    }
  });

  test("a gh stalled on a black-holed API times out instead of hanging forever", () => {
    const gh = withStubGh("#!/bin/sh\ncat > /dev/null\nsleep 30\n");
    const { wt } = repoWithOrigin();
    try {
      createDraftPr(wt, { branch: "sao/run-pr", title: "t", body: "b" }, 500);
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as SaoError).message).toBe("gh pr create timed out after 500ms");
      expect((err as SaoError).hint).toContain("open the PR manually");
    } finally {
      gh.restore();
    }
  }, 15000);

  test("a gh with EMPTY stdout fails with the manual-command hint", () => {
    const gh = withStubGh("#!/bin/sh\ncat > /dev/null\nexit 0\n");
    const { wt } = repoWithOrigin();
    try {
      createDraftPr(wt, { branch: "sao/run-pr", title: "t", body: "b" });
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as SaoError).message).toBe("gh pr create printed no PR URL");
      expect((err as SaoError).hint).toBe("open the PR manually with: gh pr create");
    } finally {
      gh.restore();
    }
  });

  test("a failing gh becomes a SaoError with stderr detail and the auth hint", () => {
    const { wt } = repoWithOrigin();
    const gh = withStubGh("#!/bin/sh\ncat > /dev/null\necho 'gh: HTTP 401' >&2\nexit 1\n");
    try {
      createDraftPr(wt, { branch: "sao/run-pr", title: "t", body: "b" });
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as SaoError).message).toBe("gh pr create failed");
      expect((err as SaoError).hint).toContain("gh: HTTP 401");
      expect((err as SaoError).hint).toContain("is gh authenticated (gh auth status)");
    } finally {
      gh.restore();
    }
  });

  test("git() passes the caller env AND the process env through to git", () => {
    // Identity comes ONLY from GIT_CONFIG_* process-env vars here — if git() ever
    // stops spreading process.env, this finalize loses its identity and fails.
    const dir = repo();
    git(dir, "config", "--unset", "user.name");
    git(dir, "config", "--unset", "user.email");
    const wt = join(dir, ".sao", "worktrees", "run-env");
    addWorktree(dir, wt, "sao/run-env", "main");
    writeFileSync(join(wt, "work.txt"), "x\n");
    const old = { ...process.env };
    process.env.GIT_CONFIG_COUNT = "2";
    process.env.GIT_CONFIG_KEY_0 = "user.name";
    process.env.GIT_CONFIG_VALUE_0 = "Env T";
    process.env.GIT_CONFIG_KEY_1 = "user.email";
    process.env.GIT_CONFIG_VALUE_1 = "env@t";
    try {
      expect(finalizeWorktree(wt, "run-env")).toBe(true);
      expect(git(wt, "log", "-1", "--format=%an")).toBe("Env T");
    } finally {
      for (const key of ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0", "GIT_CONFIG_KEY_1", "GIT_CONFIG_VALUE_1"]) {
        if (old[key] === undefined) delete process.env[key];
        else process.env[key] = old[key];
      }
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
