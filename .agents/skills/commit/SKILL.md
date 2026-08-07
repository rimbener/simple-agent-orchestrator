---
description: Commit staged/unstaged changes using Conventional Commits (no AI co-author)
argument-hint: "[optional type/scope or message hint, e.g. 'fix(engine)' or 'bump deps']"
---

# Commit (Conventional Commits)

Commit the current changes following the [Conventional Commits](https://www.conventionalcommits.org/) spec. Optional hint: $ARGUMENTS

<critical>
NEVER add a `Co-Authored-By` line (or any Claude/AI/Cursor co-author/attribution) to the commit message or body. NEVER add "Generated with" footers.
Cursor/IDE often auto-injects `Co-authored-by: Cursor <cursoragent@cursor.com>` (and similar). After every commit (and after amend), run `git log -1 --format=%B` and if any AI/Cursor co-author trailer is present, strip it immediately with `git commit --amend` using a clean heredoc message (same subject/body, no trailer). Repeat until the message is clean. Do this every time — never leave the trailer on HEAD.
</critical>

## Steps

1. **Confirm the repo.** Single package — `sao` (simple agent orchestrator). Run `git` from the repo root (`git rev-parse --show-toplevel`). Do not commit paths outside this repo.

2. **Inspect.** Run `git status --short` and `git diff` (and `git diff --staged`) to understand every change. If nothing changed, stop and report that.

3. **Safety on default branch.** Run `git rev-parse --abbrev-ref HEAD`. If it is `main` (or `master`), do NOT commit directly — create a topic branch first (short kebab name from the work) and tell the user. On any other branch, proceed.

4. **Group logically and order by dependency.** If the changes form one coherent unit, make a single commit. Otherwise split into multiple conventional commits — one per concern, never a catch-all — and commit in an order where each commit stands on its own:
   1. shared contracts first (`schema`, types, interfaces)
   2. then core before dependents (`parser`/`template` → `engine`/`nodes` → `runners` → `cli`)
   3. then workflows/agents/examples (`.agents/**`, `examples/**`)
   4. last: tooling/config/docs-only (`SPEC.md`, README, `.gitignore`, lockfiles not tied to a code commit)
   Keep a source change and its tests in the SAME commit. Lockfiles (`bun.lock`, `package-lock.json`) go with the commit that caused them.

5. **Compose the message.** Format: `type(scope): subject`
   - **type** — one of: `feat`, `fix`, `refactor`, `perf`, `test`, `docs`, `style`, `build`, `ci`, `chore`, `revert`. Infer from the diff (new behavior → `feat`; bug fix → `fix`; tests only → `test`; deps/tooling → `chore`/`build`; SPEC/examples/agents-as-docs → `docs`).
   - **scope** — short area name when useful. Prefer:
     - `cli`, `engine`, `schema`, `parser`, `template`, `agents`, `nodes`, `state`, `worktree`, `gate`, `runners`
     - `examples` for `examples/**`
     - `agents` for `.agents/agents/**` / commands / skills when that is the change
     - omit if the change spans many areas or is repo-wide
   - **subject** — imperative mood, lowercase, no trailing period, ≤ ~72 chars.
   - **body** (optional) — wrap at ~72 cols; explain *what* and *why*, not *how*. Add a footer referencing a ticket if present in the branch name or $ARGUMENTS.
   - **breaking changes** — if any, add `!` after type/scope and a `BREAKING CHANGE:` footer.
   - Honor $ARGUMENTS as a hint (forced type/scope or one-line summary), but still verify it fits the actual diff.

6. **Commit.** Stage the intended files (`git add <paths>` — avoid blanket `git add -A` if there are unrelated changes) and commit via heredoc. **Do not** include any AI co-author or "Generated with" attribution.

7. **Strip auto co-author.** Inspect `git log -1 --format=%B`. If a Cursor/AI `Co-authored-by` (or "Generated with") line was injected, strip it. Prefer `git commit --amend` with a clean heredoc first; if the trailer comes back (Cursor re-injects on `git commit`), rewrite HEAD without going through `git commit`:

   ```bash
   TREE=$(git rev-parse 'HEAD^{tree}')
   PARENT=$(git rev-parse 'HEAD^')
   NEW=$(git commit-tree "$TREE" -p "$PARENT" -m "$(cat <<'EOF'
   <same subject/body, no trailer>
   EOF
   )")
   git update-ref HEAD "$NEW"
   ```

   Verify `git log -1 --format=%B` until clean. Do this every time — never leave the trailer on HEAD.

8. **Report.** Show `git log -1 --stat` (short) and the branch. Do NOT push unless the user explicitly asks.

## Example messages

- `feat(engine): run independent nodes concurrently`
- `fix(runners): surface claude non-zero exit as node failure`
- `feat(cli): add sao validate for workflow schema checks`
- `docs(examples): add jira-bug-fix workflow`
- `docs: sao v1 spec + example workflows`
- `chore(deps): bump zod`
- `test(parser): cover cyclic depends_on rejection`
- `refactor(state)!: rename run dir layout under .sao/runs`
