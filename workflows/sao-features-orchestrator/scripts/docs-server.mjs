#!/usr/bin/env node
//
// Static file server for the run worktree, so docs/spec-viewer.html can read the
// feature docs while the agents are still writing them.
//
//   node docs-server.mjs <root> <url-file> [viewer-fallback]
//
// Loopback only, never a network interface: this serves the whole worktree.
// Directory listings are plain <a href> lists because that is exactly what the
// viewer's auto-discovery parses; `no-store` everywhere so its poll sees writes.
import { createServer } from "node:http";
import { createReadStream, existsSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";

const root = resolve(process.argv[2] ?? ".");
const urlFile = process.argv[3];
const viewerFallback = process.argv[4] ? resolve(process.argv[4]) : null;
const VIEWER_PATH = "/docs/spec-viewer.html";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".markdown": "text/markdown; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
};

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
// No access-control-allow-origin: the viewer is served from this same origin, so
// CORS buys nothing — and `*` would let any page that guessed the port read the
// body of everything below.
const noStore = { "cache-control": "no-store, max-age=0" };

function sendFile(res, file, headOnly) {
  let st;
  try {
    st = statSync(file);
  } catch {
    return end(res, 404, "not found");
  }
  if (!st.isFile()) return end(res, 404, "not found");

  res.writeHead(200, {
    ...noStore,
    "content-type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
    "content-length": st.size,
  });
  if (headOnly) return res.end();

  // stat can succeed and open still fail (EACCES, or the agent replaced the file
  // between the two). An unhandled 'error' here would take the whole server down
  // and leave the wrapper holding a pid file for a process that no longer serves.
  const stream = createReadStream(file);
  stream.on("error", (err) => {
    process.stderr.write(`docs-server: read ${file}: ${err.message}\n`);
    res.destroy();
  });
  res.on("close", () => stream.destroy());
  stream.pipe(res);
}

function end(res, code, body) {
  res.writeHead(code, { ...noStore, "content-type": "text/plain; charset=utf-8" });
  res.end(body);
}

// Exactly what the viewer asks for, and nothing else. A deny list applied only to
// directory listings would still have served GET /.git/config, /.env, /package.json
// or /tmp/<feature>/docs-server.url on request — this is the whole worktree.
const ROOT_FILES = new Set(["/SPEC.md", "/README.md", "/AGENTS.md"]);

function allowed(pathname) {
  // Rejects dotfiles and dot-dirs at any depth, and any surviving ".." segment.
  if (pathname.split("/").some((seg) => seg.startsWith("."))) return false;
  if (ROOT_FILES.has(pathname)) return true;
  return pathname === "/docs" || pathname.startsWith("/docs/");
}

// Belt and braces for listings inside docs/, should a build ever land there.
const SKIP = new Set(["node_modules", "dist", "reports", ".sao", ".git", ".stryker-tmp", "tmp"]);

function sendListing(res, dir, pathname, headOnly) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return end(res, 404, "not found");
  }
  const rows = entries
    .filter((e) => !e.name.startsWith(".") && !SKIP.has(e.name))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((e) => {
      const suffix = e.isDirectory() ? "/" : "";
      return `<li><a href="${esc(encodeURIComponent(e.name))}${suffix}">${esc(e.name + suffix)}</a></li>`;
    })
    .join("\n");
  res.writeHead(200, { ...noStore, "content-type": "text/html; charset=utf-8" });
  if (headOnly) return res.end();
  res.end(`<!doctype html><meta charset="utf-8"><title>${esc(pathname)}</title><ul>\n${rows}\n</ul>`);
}

const server = createServer((req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") return end(res, 405, "method not allowed");
  const headOnly = req.method === "HEAD";

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, "http://127.0.0.1").pathname);
  } catch {
    return end(res, 400, "bad request");
  }

  // The viewer is often untracked, so a worktree cut from HEAD will not have it.
  // Fall back to the copy in the main checkout rather than 404 on the one page
  // this server exists to serve.
  if (pathname === VIEWER_PATH && viewerFallback && !existsSync(join(root, "docs", "spec-viewer.html"))) {
    return sendFile(res, viewerFallback, headOnly);
  }

  // A bare origin is what a human pastes; send them to the page.
  if (pathname === "/") {
    res.writeHead(302, { ...noStore, location: VIEWER_PATH });
    return res.end();
  }
  // 404 rather than 403: a probe learns nothing about what exists here.
  if (!allowed(pathname)) return end(res, 404, "not found");

  const target = resolve(join(root, pathname));
  if (target !== root && !target.startsWith(root + sep)) return end(res, 404, "not found");

  let st;
  try {
    st = statSync(target);
  } catch {
    return end(res, 404, "not found");
  }

  if (st.isDirectory()) {
    if (!pathname.endsWith("/")) {
      res.writeHead(301, { ...noStore, location: pathname + "/" });
      return res.end();
    }
    const index = join(target, "index.html");
    return existsSync(index) ? sendFile(res, index, headOnly) : sendListing(res, target, pathname, headOnly);
  }
  sendFile(res, target, headOnly);
});

server.on("error", (err) => {
  process.stderr.write(`docs-server: ${err.message}\n`);
  process.exit(1);
});

// Port 0 = let the OS pick a free one, so concurrent runs never collide.
server.listen(0, "127.0.0.1", () => {
  const url = `http://127.0.0.1:${server.address().port}${VIEWER_PATH}`;
  if (urlFile) writeFileSync(urlFile, url + "\n");
  process.stdout.write(url + "\n");
});

// story_partner / spec_partner print the url file verbatim on every turn, so it must
// never outlive the process serving it — a resumed run would otherwise advertise a
// dead link. `exit` covers the crash paths that SIGTERM handling alone would miss.
const dropUrlFile = () => {
  try {
    if (urlFile) rmSync(urlFile, { force: true });
  } catch {
    /* nothing useful left to do while exiting */
  }
};
process.on("exit", dropUrlFile);
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    dropUrlFile();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  });
}

// `sao clean` deletes the worktree this server is rooted in. Nothing signals us when
// that happens, so notice it and exit rather than serving a directory that is gone.
setInterval(() => {
  if (!existsSync(root)) {
    process.stderr.write("docs-server: worktree removed — exiting\n");
    dropUrlFile();
    process.exit(0);
  }
}, 30_000).unref();
