import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * workflows/sao-features-orchestrator/scripts/docs-server.mjs — the only network
 * surface the features workflow opens. It serves a run worktree over loopback so
 * docs/spec-viewer.html can read the feature docs while the agents write them.
 *
 * These cover the confinement rules, because the worktree it is rooted in holds
 * far more than the docs the viewer asks for.
 */
const SERVER = join(import.meta.dir, "..", "workflows", "sao-features-orchestrator", "scripts", "docs-server.mjs");

let root: string;
let base: string;
let child: ReturnType<typeof spawn>;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "sao-docs-server-"));

  // A worktree shaped like the real thing: what the viewer wants, next to what it
  // must never be handed.
  mkdirSync(join(root, "docs", "features", "demo"), { recursive: true });
  mkdirSync(join(root, "docs", "c4"), { recursive: true });
  mkdirSync(join(root, ".git"), { recursive: true });
  mkdirSync(join(root, "tmp", "demo"), { recursive: true });
  mkdirSync(join(root, "node_modules", "evil"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });

  writeFileSync(join(root, "docs", "spec-viewer.html"), "<title>viewer</title>");
  writeFileSync(join(root, "docs", "features", "demo", "user-story.md"), "# story");
  writeFileSync(join(root, "docs", "c4", "C1-Context.md"), "# c1");
  writeFileSync(join(root, "SPEC.md"), "# spec");
  writeFileSync(join(root, "README.md"), "# readme");
  writeFileSync(join(root, "AGENTS.md"), "# agents");
  writeFileSync(join(root, ".env"), "SECRET=hunter2");
  writeFileSync(join(root, ".git", "config"), "[remote]");
  writeFileSync(join(root, "package.json"), '{"name":"secret"}');
  writeFileSync(join(root, "src", "cli.ts"), "export {};");
  writeFileSync(join(root, "tmp", "demo", "docs-server.url"), "http://127.0.0.1:1/x");
  writeFileSync(join(root, "node_modules", "evil", "index.js"), "module.exports=1");

  const urlFile = join(root, "tmp", "demo", "reported.url");
  child = spawn(process.execPath, [SERVER, root, urlFile], { stdio: ["ignore", "pipe", "pipe"] });

  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("docs-server never reported a URL")), 10_000);
    child.stdout?.on("data", (chunk: Buffer) => {
      const line = chunk.toString().trim();
      if (line.startsWith("http://")) {
        clearTimeout(timer);
        resolve(line);
      }
    });
    child.on("error", reject);
  });
  base = url.replace("/docs/spec-viewer.html", "");
});

afterAll(() => {
  child?.kill();
});

const get = (path: string, init?: RequestInit) => fetch(base + path, { redirect: "manual", ...init });

describe("what the viewer needs is served", () => {
  test.each([
    ["/docs/spec-viewer.html", "the page itself"],
    ["/docs/features/demo/user-story.md", "a feature doc"],
    ["/docs/c4/C1-Context.md", "a reference doc"],
    ["/SPEC.md", "a root markdown file"],
    ["/README.md", "a root markdown file"],
    ["/AGENTS.md", "a root markdown file"],
  ])("%s is reachable (%s)", async (path) => {
    expect((await get(path)).status).toBe(200);
  });

  test("directory listings are relative hrefs the viewer can parse", async () => {
    const html = await (await get("/docs/features/")).text();
    // The viewer keeps only hrefs that are relative and end in "/" or ".md".
    expect(html).toContain('href="demo/"');
    expect(html).not.toContain('href="/');
  });

  test("markdown is served as markdown, uncached so the poll sees writes", async () => {
    const res = await get("/SPEC.md");
    expect(res.headers.get("content-type")).toContain("text/markdown");
    expect(res.headers.get("cache-control")).toContain("no-store");
  });
});

describe("everything else in the worktree is not", () => {
  test.each([
    ["/.env", "secrets beside the docs"],
    ["/.git/config", "the repository internals"],
    ["/package.json", "an unrelated root file"],
    ["/src/cli.ts", "source"],
    ["/node_modules/evil/index.js", "dependencies"],
    ["/tmp/demo/docs-server.url", "the run's own viewer state"],
  ])("%s is refused (%s)", async (path) => {
    const res = await get(path);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("SECRET");
  });

  test("a dot-segment anywhere is refused, encoded or not", async () => {
    for (const path of ["/docs/../.env", "/docs/%2e%2e/.env", "/docs/.hidden/x.md"]) {
      expect((await get(path)).status).toBe(404);
    }
  });

  test("an absolute path outside the root cannot be reached", async () => {
    expect((await get("/docs/../../../etc/passwd")).status).toBe(404);
  });
});

describe("origin and method handling", () => {
  test("no CORS header — the viewer is same-origin, so nothing else may read a reply", async () => {
    const res = await get("/SPEC.md", { headers: { origin: "https://evil.example" } });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("HEAD returns the headers and no body", async () => {
    const res = await get("/SPEC.md", { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });

  test("writes are refused", async () => {
    expect((await get("/SPEC.md", { method: "POST" })).status).toBe(405);
    expect((await get("/SPEC.md", { method: "DELETE" })).status).toBe(405);
  });

  test("the bare origin redirects to the viewer", async () => {
    const res = await get("/");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/docs/spec-viewer.html");
  });

  test("a refused request does not take the server down", async () => {
    await get("/.env");
    await get("/node_modules/evil/index.js");
    expect((await get("/SPEC.md")).status).toBe(200);
  });
});
