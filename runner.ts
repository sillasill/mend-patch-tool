// runner.ts — the trial runner for mend.
//
// When the grader sets MAKEFUN_ENV_URL, main.ts hands over here. The
// runner fetches the trial's checks, runs `node main.ts` once per check
// in a fresh directory holding exactly that check's files (with the
// check's stdin and without MAKEFUN_ENV_URL), and posts each run's exit
// code, stdout and resulting files back. A run still going after 10
// seconds is stopped and reported as exit 124.

import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

type Check = { id: string; argv: string[]; stdin: string | null; files: Record<string, string> };
type Result = { id: string; exit: number; stdout: string; files: Record<string, string> };

const RUN_TIMEOUT_MS = 10_000;
const BATCH_SIZE = 100;

function entryDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

function readTree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.isFile()) {
        out[relative(root, p).split(sep).join("/")] = readFileSync(p, "utf8");
      }
    }
  };
  walk(root);
  return out;
}

function runOne(check: Check): Promise<Result> {
  return new Promise((resolve) => {
    const dir = mkdtempSync(join(tmpdir(), "mend-check-"));
    for (const [path, text] of Object.entries(check.files)) {
      const full = join(dir, path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, text, "utf8");
    }
    const env: Record<string, string | undefined> = { ...process.env };
    delete env.MAKEFUN_ENV_URL;
    const child = spawn(
      process.execPath,
      [join(entryDir(), "main.ts"), ...check.argv],
      { cwd: dir, env, stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, RUN_TIMEOUT_MS);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.on("error", () => {
      clearTimeout(timer);
      finish(1);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      finish(timedOut ? 124 : typeof code === "number" ? code : 1);
    });
    let finished = false;
    function finish(exit: number): void {
      if (finished) return;
      finished = true;
      let files: Record<string, string> = {};
      try {
        files = readTree(dir);
      } catch {
        files = {};
      }
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // The directory is temporary; a failed cleanup is not a result.
      }
      resolve({ id: check.id, exit, stdout, files });
    }
    if (check.stdin !== null) {
      child.stdin.end(check.stdin, "utf8");
    } else {
      child.stdin.end();
    }
  });
}

export async function runTrials(): Promise<void> {
  const base = (process.env.MAKEFUN_ENV_URL ?? "").replace(/\/+$/, "");
  const res = await fetch(`${base}/checks`);
  if (!res.ok) throw new Error(`GET /checks failed: ${res.status}`);
  const data = (await res.json()) as { checks: Check[] };
  const checks = data.checks;
  const results: Result[] = [];
  for (const check of checks) {
    results.push(await runOne(check));
  }
  for (let i = 0; i < results.length; i += BATCH_SIZE) {
    const batch = results.slice(i, i + BATCH_SIZE);
    const posted = await fetch(`${base}/results`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ results: batch }),
    });
    if (!posted.ok) throw new Error(`POST /results failed: ${posted.status}`);
  }
}
