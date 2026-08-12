import { closeSync, existsSync, openSync, readdirSync, readSync, rmSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { SaoError } from "./errors";
import { isPidAlive, listRuns, type RunPaths, runLockHolder } from "./state";
import {
  branchExists,
  branchIsMergedElsewhere,
  deleteBranch,
  pruneWorktrees,
  removeWorktree,
  worktreeHasChanges,
  worktreeRelPath,
} from "./worktree";

/** Command cores for `sao list` / `sao logs` / `sao clean` — cli.ts only wires them. */

const AGE_STEPS: Array<[limit: number, divisor: number, unit: string]> = [
  [60_000, 1_000, "s"],
  [3_600_000, 60_000, "m"],
  [86_400_000, 3_600_000, "h"],
];

/** Compact age like "42s", "5m", "3h", "12d"; "?" for unparseable timestamps. */
export function humanAge(fromIso: string, now: Date): string {
  const ms = now.getTime() - new Date(fromIso).getTime();
  if (Number.isNaN(ms)) return "?";
  const clamped = Math.max(0, ms);
  for (const [limit, divisor, unit] of AGE_STEPS) {
    if (clamped < limit) return `${Math.floor(clamped / divisor)}${unit}`;
  }
  return `${Math.floor(clamped / 86_400_000)}d`;
}

/** `sao list` table lines: id, workflow, status, age — or a friendly empty message. */
export function formatRunList(root: string, now: Date): string[] {
  const listings = listRuns(root);
  if (listings.length === 0) return ["no runs found (nothing under .sao/runs)"];
  const rows = listings.map(({ state }) => [
    state.id,
    basename(state.workflow),
    state.status,
    humanAge(state.createdAt, now),
  ]);
  const header = ["RUN", "WORKFLOW", "STATUS", "AGE"];
  const widths = header.map((title, col) => Math.max(title.length, ...rows.map((row) => row[col]!.length)));
  const line = (row: string[]) =>
    row
      .map((cell, col) => cell.padEnd(widths[col]!))
      .join("  ")
      .trimEnd();
  return [line(header), ...rows.map(line)];
}

// `<node>.log` (single) or `<node>.<iteration>.log` (loop iterations).
const LOG_FILE_PATTERN = /^(.+?)(?:\.(\d+))?\.log$/;

/**
 * Log files for the run, optionally filtered to one node. Ordered by `nodeOrder`
 * (state.json's node map is in dependency order) so a dump reads like the run;
 * nodes not in the order (renamed since) sort last, alphabetically.
 */
// Stryker disable next-line ArrayDeclaration: equivalent — with junk in the default order, every real node ranks identically past it and ties still break alphabetically
export function listLogFiles(logsDir: string, nodeId?: string, nodeOrder: string[] = []): string[] {
  if (!existsSync(logsDir)) return [];
  const position = new Map(nodeOrder.map((id, index) => [id, index]));
  const files: Array<{ file: string; node: string; rank: number; iteration: number }> = [];
  for (const file of readdirSync(logsDir)) {
    const match = LOG_FILE_PATTERN.exec(file);
    if (!match) continue;
    const node = match[1]!;
    if (nodeId !== undefined && node !== nodeId) continue;
    files.push({
      file,
      node,
      rank: position.get(node) ?? nodeOrder.length,
      // Stryker disable next-line ConditionalExpression: equivalent — a node writes either one .log or .N.log iterations, never both, so the 0 default is only ever compared against itself
      iteration: match[2] !== undefined ? Number(match[2]) : 0,
    });
  }
  return files
    .sort((a, b) => a.rank - b.rank || a.node.localeCompare(b.node) || a.iteration - b.iteration)
    .map((entry) => entry.file);
}

export interface LogPoller {
  /** Print everything new since the last poll; returns whether anything was printed. */
  poll: () => boolean;
}

/**
 * Incremental log reader behind `sao logs [--follow]`: each poll() prints the bytes
 * appended since the last poll, with a header line whenever the source file changes.
 * One-shot mode is a single poll(); --follow calls it on an interval.
 */
export function makeLogPoller(
  paths: RunPaths,
  nodeId: string | undefined,
  write: (text: string) => void,
  // Stryker disable next-line ArrayDeclaration: equivalent — see listLogFiles' default
  nodeOrder: string[] = [],
): LogPoller {
  const offsets = new Map<string, number>();
  // One decoder per file, kept across polls: it holds back a UTF-8 sequence split
  // at a poll boundary instead of decoding each half as garbage.
  const decoders = new Map<string, StringDecoder>();
  let lastFile: string | undefined;
  return {
    poll: () => {
      let printed = false;
      for (const file of listLogFiles(paths.logsDir, nodeId, nodeOrder)) {
        const fullPath = join(paths.logsDir, file);
        // Files can vanish between readdir and here (sao clean --all mid-follow) —
        // skip quietly rather than crash the follow loop.
        // Stryker disable next-line ObjectLiteral,BooleanLiteral: guards the readdir→stat race, which a deterministic test cannot reproduce
        const stat = statSync(fullPath, { throwIfNoEntry: false });
        // Stryker disable next-line ConditionalExpression: same race — only a vanish between readdir and stat makes this true
        if (stat === undefined) continue;
        let offset = offsets.get(file) ?? 0;
        if (stat.size < offset) {
          offset = 0; // truncated/rotated externally: start over instead of wedging
          decoders.delete(file);
        }
        // Stryker disable next-line ConditionalExpression,EqualityOperator: at size === offset the chunk below is empty, decodes to "", and the text guard continues anyway — this line only saves the read
        if (stat.size <= offset) continue;
        // Positional read of only the new bytes — re-reading a multi-GB build log
        // in full every 300ms poll would turn --follow into continuous full-file IO.
        let chunk: Buffer;
        try {
          const fd = openSync(fullPath, "r");
          // Stryker disable next-line ArithmeticOperator: an oversized want only over-allocates — readSync returns the true byte count and the buffer is sliced to it
          const wanted = stat.size - offset;
          const buffer = Buffer.allocUnsafe(wanted);
          // No try/finally around the read: a positional read on an open regular file
          // only fails on hardware-grade errors, where leaking one fd into the outer
          // catch is acceptable (and a finally block defeats mutation attribution).
          const bytesRead = readSync(fd, buffer, 0, wanted, offset);
          closeSync(fd);
          chunk = buffer.subarray(0, bytesRead);
        } catch /* Stryker disable next-line all: guards the stat→open race, which a deterministic test cannot reproduce */ {
          continue;
        }
        offsets.set(file, offset + chunk.byteLength);
        const decoder = decoders.get(file) ?? new StringDecoder("utf8");
        decoders.set(file, decoder);
        const text = decoder.write(chunk);
        if (text === "") continue; // chunk was only a partial multi-byte sequence
        if (file !== lastFile) {
          write(`── ${file} ──\n`);
          lastFile = file;
        }
        write(text);
        printed = true;
      }
      return printed;
    },
  };
}

/** One-shot `sao logs`: dump everything; error when a node filter matches nothing. */
export function printLogs(
  paths: RunPaths,
  nodeId: string | undefined,
  write: (text: string) => void,
  // Stryker disable next-line ArrayDeclaration: equivalent — see listLogFiles' default
  nodeOrder: string[] = [],
): void {
  if (listLogFiles(paths.logsDir, nodeId).length === 0) {
    const available = listLogFiles(paths.logsDir).join(", ") || "(none)";
    throw new SaoError(
      nodeId !== undefined ? `no logs for node "${nodeId}"` : "no logs for this run yet",
      `available logs: ${available}`,
    );
  }
  makeLogPoller(paths, nodeId, write, nodeOrder).poll();
}

export interface CleanSummary {
  worktrees: number;
  branches: number;
  runDirs: number;
  skippedRunning: number;
  skippedUnfinished: number;
  keptDirty: number;
  keptUnmergedBranches: number;
}

/**
 * `sao clean [--all]`: housekeeping that must never eat work.
 * - Live runs (holding the engine lock, or status running with a live/unknowable
 *   pid) are never touched; with `all`, a legacy running run with NO recorded pid
 *   counts as crashed (the user explicitly asked to discard).
 * - By default only SUCCEEDED runs are cleaned — a failed/rejected run's worktree
 *   and branch are its resume target and often hold committed-but-unmerged work.
 * - Branches are deleted only once their tip is reachable from another ref;
 *   worktrees with uncommitted changes are kept. `all` overrides all three.
 */
export function cleanRuns(root: string, all: boolean, print: (line: string) => void): CleanSummary {
  const summary: CleanSummary = {
    worktrees: 0,
    branches: 0,
    runDirs: 0,
    skippedRunning: 0,
    skippedUnfinished: 0,
    keptDirty: 0,
    keptUnmergedBranches: 0,
  };
  for (const { state, paths } of listRuns(root)) {
    if (runLockHolder(paths) !== undefined) {
      summary.skippedRunning++; // a live engine owns this run right now (e.g. a resume started after our listing)
      continue;
    }
    if (state.status === "running" && (state.pid !== undefined ? isPidAlive(state.pid) : !all)) {
      summary.skippedRunning++;
      continue;
    }
    if (!all && state.status !== "succeeded") {
      summary.skippedUnfinished++; // failed/rejected: the worktree+branch are the resume target
      continue;
    }
    if (state.worktree !== undefined) {
      // A tampered state.worktree must never choose what gets force-removed — only
      // the layout sao itself creates is eligible.
      if (state.worktree !== worktreeRelPath(state.id)) {
        print(`⚠ ${state.id}: state.worktree is not the expected ${worktreeRelPath(state.id)} — leaving it alone`);
      } else {
        const worktreePath = resolve(root, state.worktree);
        if (existsSync(worktreePath)) {
          // A succeeded run is only dirty when its finalize failed — still work.
          // Only succeeded runs get this far (the unfinished check above), and
          // resume refuses those — so point at the manual fix, not a dead end.
          if (!all && worktreeHasChanges(worktreePath)) {
            print(
              `⚠ ${state.id}: worktree has uncommitted changes — kept (commit them in the worktree, or pass --all to discard)`,
            );
            summary.keptDirty++;
            continue;
          }
          try {
            removeWorktree(root, worktreePath);
            summary.worktrees++;
          } catch (err) {
            print(`⚠ ${state.id}: ${err instanceof Error ? err.message : String(err)}`);
            continue; // keep the branch and run dir for a worktree we could not remove
          }
        }
        if (state.branch !== undefined) {
          // Deleting an unmerged branch is the one clean action that loses commits.
          if (all || branchIsMergedElsewhere(root, state.branch)) {
            if (deleteBranch(root, state.branch)) summary.branches++;
          } else if (branchExists(root, state.branch)) {
            summary.keptUnmergedBranches++;
          }
        }
      }
    }
    if (all) {
      // Stryker disable next-line BooleanLiteral,ObjectLiteral: force only suppresses ENOENT for a dir that provably exists — its state.json was just read
      rmSync(paths.dir, { recursive: true, force: true });
      summary.runDirs++;
    }
  }
  // Stryker disable next-line all: housekeeping — worktree remove already deregisters its entry, so pruning (or skipping it) is unobservable
  if (summary.worktrees > 0) pruneWorktrees(root);
  return summary;
}

/** Human summary line for cleanRuns. */
export function formatCleanSummary(summary: CleanSummary): string {
  const parts = [`${summary.worktrees} worktrees`, `${summary.branches} branches`, `${summary.runDirs} run dirs`];
  const notes = [
    summary.skippedRunning > 0 ? `skipped ${summary.skippedRunning} running` : "",
    summary.skippedUnfinished > 0 ? `kept ${summary.skippedUnfinished} unfinished — resume them, or pass --all` : "",
    summary.keptDirty > 0 ? `kept ${summary.keptDirty} with uncommitted changes` : "",
    summary.keptUnmergedBranches > 0 ? `kept ${summary.keptUnmergedBranches} unmerged branches` : "",
  ].filter((note) => note !== "");
  return `cleaned: ${parts.join(", ")}${notes.length > 0 ? ` (${notes.join("; ")})` : ""}`;
}
