// check.ts — local verification for the mend rewrite.
//
// Usage: node check.ts
//   1. Runs the kit's 3 practice trials (100 checks each) through main.ts
//      and compares exit code, stdout and every file against expected.json.
//   2. Runs 106 hand-built adversarial cases with hand-computed outcomes.
//   3. Runs the full practice suite twice and requires byte-identical output.
// Exits non-zero when anything fails.

import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const KIT = join(
  process.env.HOME ?? "",
  "workspace/makefun/kits/hidden-spec-cli-01-run-20261122/hidden-spec-cli-01-run-20261122-kit",
);
const MAIN = join(HERE, "main.ts");

type Files = Record<string, string>;
type Outcome = { exit: number; stdout: string; files: Files };

function writeTree(root: string, files: Files): void {
  for (const [p, text] of Object.entries(files)) {
    const full = join(root, p);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text, "utf8");
  }
}

function readTree(root: string): Files {
  const out: Files = {};
  const walk = (dir: string): void => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.isFile()) out[relative(root, p).split(sep).join("/")] = readFileSync(p, "utf8");
    }
  };
  walk(root);
  return out;
}

function sameFiles(a: Files, b: Files): boolean {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] !== kb[i] || a[ka[i]] !== b[ka[i]]) return false;
  }
  return true;
}

// Run main.ts once in a fresh directory holding `files`, with `argv` and
// `stdin` (null closes stdin at once). Returns the observed outcome.
function runCli(files: Files, argv: string[], stdin: string | null): Outcome {
  const base = mkdtempSync(join(tmpdir(), "mend-check-"));
  const work = join(base, "work");
  mkdirSync(work, { recursive: true });
  writeTree(work, files);
  const res = spawnSync(process.execPath, [MAIN, ...argv], {
    cwd: work,
    input: stdin ?? undefined,
    encoding: "utf8",
    timeout: 10_000,
  });
  const out: Outcome = {
    exit: typeof res.status === "number" ? res.status : 1,
    stdout: res.stdout ?? "",
    files: readTree(work),
  };
  rmSync(base, { recursive: true, force: true });
  return out;
}

function diffOutcome(got: Outcome, want: Outcome): string[] {
  const problems: string[] = [];
  if (got.exit !== want.exit) problems.push(`exit: got ${got.exit}, want ${want.exit}`);
  if (got.stdout !== want.stdout) {
    problems.push(`stdout: got ${JSON.stringify(got.stdout)}, want ${JSON.stringify(want.stdout)}`);
  }
  if (!sameFiles(got.files, want.files)) {
    problems.push(`files: got ${JSON.stringify(got.files)}, want ${JSON.stringify(want.files)}`);
  }
  return problems;
}

// ------------------------------------------------------------ practice trials

type PracticeCheck = { id: string; argv: string[]; stdin: string | null; files: Files };
type ExpectedCheck = { id: string; group: string; exit: number; stdout: string; files: Files };

function runPractice(): { perTrial: Array<{ trial: number; passed: number; total: number; groups: Record<string, [number, number]> }>; serialized: string } {
  const perTrial: Array<{ trial: number; passed: number; total: number; groups: Record<string, [number, number]> }> = [];
  const allLines: string[] = [];
  for (let t = 0; t < 3; t++) {
    const dir = join(KIT, "practice", `trial-${t}`);
    const checks = (JSON.parse(readFileSync(join(dir, "input", "env", "checks.json"), "utf8")) as { checks: PracticeCheck[] }).checks;
    const expected = (JSON.parse(readFileSync(join(dir, "reference", "expected.json"), "utf8")) as { checks: ExpectedCheck[] }).checks;
    const byId = new Map(expected.map((e) => [e.id, e]));
    let passed = 0;
    const groups: Record<string, [number, number]> = {};
    for (const c of checks) {
      const want = byId.get(c.id)!;
      const got = runCli(c.files, c.argv, c.stdin);
      const ok = got.exit === want.exit && got.stdout === want.stdout && sameFiles(got.files, want.files);
      if (ok) passed++;
      const g = groups[want.group] ?? [0, 0];
      g[1]++;
      if (ok) g[0]++;
      groups[want.group] = g;
      allLines.push(JSON.stringify({ trial: t, id: c.id, exit: got.exit, stdout: got.stdout, files: got.files }));
      if (!ok) {
        console.log(`trial-${t} ${c.id} [${want.group}] FAILED`);
        for (const p of diffOutcome(got, { exit: want.exit, stdout: want.stdout, files: want.files })) {
          console.log(`  ${p}`);
        }
      }
    }
    perTrial.push({ trial: t, passed, total: checks.length, groups });
  }
  return { perTrial, serialized: allLines.join("\n") };
}

// --------------------------------------------------------- adversarial cases

// patchVia: "stdin" feeds the patch on stdin; "file" writes it to
// ../p.diff and passes that path; "missing" passes a path that does not
// exist; "dir" passes a directory path.
type AdvCase = {
  name: string;
  files: Files;
  argv: string[];
  patch: string;
  patchVia: "stdin" | "file" | "missing" | "dir";
  stdin: string | null;
  want: Outcome;
};

function adv(
  name: string,
  files: Files,
  argv: string[],
  patch: string,
  patchVia: AdvCase["patchVia"],
  stdin: string | null,
  exit: number,
  stdout: string,
  outFiles: Files,
): AdvCase {
  return { name, files, argv, patch, patchVia, stdin, want: { exit, stdout, files: outFiles } };
}

function runAdv(c: AdvCase): Outcome {
  const base = mkdtempSync(join(tmpdir(), "mend-check-"));
  const work = join(base, "work");
  mkdirSync(work, { recursive: true });
  writeTree(work, c.files);
  let argv = [...c.argv];
  let input: string | undefined;
  if (c.patchVia === "stdin") {
    input = c.patch;
  } else if (c.patchVia === "file") {
    writeFileSync(join(base, "p.diff"), c.patch, "utf8");
    argv = [...argv, "../p.diff"];
    input = c.stdin ?? undefined;
  } else if (c.patchVia === "missing") {
    argv = [...argv, "missing.diff"];
    input = c.stdin ?? undefined;
  } else {
    mkdirSync(join(work, "subdir"), { recursive: true });
    argv = [...argv, "subdir"];
    input = c.stdin ?? undefined;
  }
  const res = spawnSync(process.execPath, [MAIN, ...argv], {
    cwd: work,
    input,
    encoding: "utf8",
    timeout: 10_000,
  });
  const out: Outcome = {
    exit: typeof res.status === "number" ? res.status : 1,
    stdout: res.stdout ?? "",
    files: readTree(work),
  };
  rmSync(base, { recursive: true, force: true });
  return out;
}

const ADV: AdvCase[] = [
  // --- CLI / usage (12) ---
  adv("cli-empty-stdin", { "a.txt": "a\n" }, [], "", "stdin", null, 2, "error: format\n", { "a.txt": "a\n" }),
  adv("cli-unknown-option", {}, ["--foo"], "x", "stdin", null, 2, "error: usage\n", {}),
  adv("cli-bad-format-value", {}, ["--format=bad"], "x", "stdin", null, 2, "error: usage\n", {}),
  adv("cli-format-twice", {}, ["--format=json", "--format=unified"], "x", "stdin", null, 2, "error: usage\n", {}),
  adv("cli-check-twice", {}, ["--check", "--check"], "x", "stdin", null, 2, "error: usage\n", {}),
  adv("cli-two-positionals", {}, ["a.diff", "b.diff"], "x", "stdin", null, 2, "error: usage\n", {}),
  adv("cli-format-bare", {}, ["--format"], "x", "stdin", null, 2, "error: usage\n", {}),
  adv("cli-check-equals", {}, ["--check=x"], "x", "stdin", null, 2, "error: usage\n", {}),
  adv("cli-dashdash-missing", {}, ["--", "nope.diff"], "x", "stdin", null, 2, "error: no-patch\n", {}),
  adv("cli-dash-stdin", {}, ["-"], "--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1 @@\n+hi\n", "stdin", null, 0, "A n.txt\nok: 1 file\n", { "n.txt": "hi\n" }),
  adv("cli-strict-twice", {}, ["--strict", "--strict"], "x", "stdin", null, 2, "error: usage\n", {}),
  adv("cli-format-then-check", {}, ["--format=json", "--check"], '[{"command":"create","path":"n.txt","file_text":"hi\\n"}]', "stdin", null, 0, "A n.txt\nok: 1 file\n", {}),

  // --- no-patch / format / parse, general (10) ---
  adv("gen-patch-missing", {}, [], "", "missing", null, 2, "error: no-patch\n", {}),
  adv("gen-patch-is-dir", {}, [], "", "dir", null, 2, "error: no-patch\n", {}),
  adv("gen-prose-only", {}, [], "Just some prose.\nNothing here.\n", "stdin", null, 2, "error: format\n", {}),
  adv("gen-blank-only", {}, [], "  \n\t\n", "stdin", null, 2, "error: format\n", {}),
  adv("gen-json-empty-obj", {}, [], "{}\n", "stdin", null, 2, "error: parse 1\n", {}),
  adv("gen-json-empty-array", {}, [], "[]\n", "stdin", null, 2, "error: parse 1\n", {}),
  adv("gen-json-array-bad-item", {}, [], "[1]\n", "stdin", null, 2, "error: parse 1\n", {}),
  adv("gen-jsonl-bad-second", {}, [], '{"command":"create","path":"a.txt","file_text":"x"}\nnot json\n', "stdin", null, 2, "error: parse 2\n", {}),
  adv("gen-usage-beats-nopatch", {}, ["--bad"], "", "missing", null, 2, "error: usage\n", {}),
  adv("gen-json-array-multiline", {}, [], '[\n{"command":"create","path":"a.txt","file_text":"x"}\n]\n', "stdin", null, 0, "A a.txt\nok: 1 file\n", { "a.txt": "x" }),

  // --- unified parse (10) ---
  adv("uni-malformed-diffgit", {}, [], "diff --git a/x\n", "stdin", null, 2, "error: parse 1\n", {}),
  adv("uni-dangling-dashes", {}, [], "diff --git a/a.txt b/a.txt\n--- a.txt\nindex 123\n", "stdin", null, 2, "error: parse 3\n", {}),
  adv("uni-hunk-first", {}, [], "@@ -1 +1 @@\n x\n", "stdin", null, 2, "error: format\n", {}),
  adv("uni-hunk-before-section", { "a.txt": "a\n" }, [], "@@ -1 +1 @@\n x\ndiff --git a/a.txt b/a.txt\n--- a.txt\n+++ a.txt\n@@ -1 +1 @@\n-a\n+b\n", "stdin", null, 2, "error: parse 1\n", { "a.txt": "a\n" }),
  adv("uni-bad-hunk-head", {}, [], "diff --git a/a.txt b/a.txt\n@@ -x +1 @@\n", "stdin", null, 2, "error: parse 2\n", {}),
  adv("uni-lone-dashes-is-old-line", { "a.txt": "a\n" }, [], "diff --git a/a.txt b/a.txt\n@@ -1 +1 @@\n-a\n+b\n--- stray\n", "stdin", null, 1, "error: no-match a.txt\nfailed: 1 of 1 edits\n", { "a.txt": "a\n" }),
  adv("uni-paths-with-spaces", { "my file.txt": "x\n" }, [], "diff --git a/my file.txt b/my file.txt\n@@ -1 +1 @@\n-x\n+y\n", "stdin", null, 0, "M my file.txt\nok: 1 file\n", { "my file.txt": "y\n" }),
  adv("uni-rename", { "old.txt": "a\n" }, [], "diff --git a/old.txt b/new.txt\nsimilarity index 90%\nrename from old.txt\nrename to new.txt\n@@ -1 +1 @@\n-a\n+b\n", "stdin", null, 0, "R old.txt -> new.txt\nok: 1 file\n", { "new.txt": "b\n" }),
  adv("uni-new-file-mode", {}, [], "diff --git a/n.txt b/n.txt\nnew file mode 100644\n@@ -0,0 +1 @@\n+hello\n", "stdin", null, 0, "A n.txt\nok: 1 file\n", { "n.txt": "hello\n" }),
  adv("uni-deleted-file-mode", { "a.txt": "a\n" }, [], "diff --git a/a.txt b/a.txt\ndeleted file mode 100644\n@@ -1 +0,0 @@\n-a\n", "stdin", null, 0, "D a.txt\nok: 1 file\n", {}),
  adv("uni-devnull-create", {}, [], "--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+hi\n", "stdin", null, 0, "A new.txt\nok: 1 file\n", { "new.txt": "hi\n" }),

  // --- unified apply (22) ---
  adv("uni-basic-change", { "a.txt": "one\ntwo\nthree\n" }, [], "--- a.txt\n+++ a.txt\n@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n", "stdin", null, 0, "M a.txt\nok: 1 file\n", { "a.txt": "one\nTWO\nthree\n" }),
  adv("uni-context-from-file", { "a.txt": "one\ntwo\nthree\n" }, [], "--- a.txt\n+++ a.txt\n@@ -1,3 +1,3 @@\n one\n-two \n+TWO\n three\n", "stdin", null, 0, "M a.txt\nok: 1 file\n", { "a.txt": "one\nTWO\nthree\n" }),
  adv("uni-tier2-reindent", { "a.txt": "  one\n  two\n  three\n" }, [], "--- a.txt\n+++ a.txt\n@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n", "stdin", null, 0, "M a.txt\nok: 1 file\n", { "a.txt": "  one\n  TWO\n  three\n" }),
  adv("uni-nearest-occurrence", { "a.txt": "x\na\nx\na\nx\n" }, [], "--- a.txt\n+++ a.txt\n@@ -4 +4 @@\n-a\n+b\n", "stdin", null, 0, "M a.txt\nok: 1 file\n", { "a.txt": "x\na\nx\nb\nx\n" }),
  adv("uni-nearest-tie-earlier", { "a.txt": "a\nx\na\n" }, [], "--- a.txt\n+++ a.txt\n@@ -2 +2 @@\n-a\n+b\n", "stdin", null, 0, "M a.txt\nok: 1 file\n", { "a.txt": "b\nx\na\n" }),
  adv("uni-empty-insert", { "a.txt": "a\nb\nc\n" }, [], "--- a.txt\n+++ a.txt\n@@ -2,0 +3 @@\n+X\n", "stdin", null, 0, "M a.txt\nok: 1 file\n", { "a.txt": "a\nb\nX\nc\n" }),
  adv("uni-empty-insert-end", { "a.txt": "a\nb\n" }, [], "--- a.txt\n+++ a.txt\n@@ -3,0 +3 @@\n+X\n", "stdin", null, 0, "M a.txt\nok: 1 file\n", { "a.txt": "a\nb\nX\n" }),
  adv("uni-no-newline-eof", { "a.txt": "a\nb" }, [], "--- a.txt\n+++ a.txt\n@@ -1,2 +1,2 @@\n a\n-b\n+B\n\\ No newline at end of file\n", "stdin", null, 0, "M a.txt\nok: 1 file\n", { "a.txt": "a\nB" }),
  adv("uni-newline-added-eof", { "a.txt": "a\nb" }, [], "--- a.txt\n+++ a.txt\n@@ -1,2 +1,2 @@\n a\n-b\n+B\n", "stdin", null, 0, "M a.txt\nok: 1 file\n", { "a.txt": "a\nB\n" }),
  adv("uni-create-no-break", {}, [], "--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1,2 @@\n+one\n+two\n\\ No newline at end of file\n", "stdin", null, 0, "A n.txt\nok: 1 file\n", { "n.txt": "one\ntwo" }),
  adv("uni-create-with-break", {}, [], "--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1,2 @@\n+one\n+two\n", "stdin", null, 0, "A n.txt\nok: 1 file\n", { "n.txt": "one\ntwo\n" }),
  adv("uni-multi-hunk-drift", { "a.txt": "a\nb\nc\nd\ne\nf\n" }, [], "--- a.txt\n+++ a.txt\n@@ -2 +2 @@\n-b\n+B\n+X\n@@ -5 +5 @@\n-e\n+E\n", "stdin", null, 0, "M a.txt\nok: 1 file\n", { "a.txt": "a\nB\nX\nc\nd\nE\nf\n" }),
  adv("uni-hunk-fails-no-match", { "a.txt": "a\nb\n" }, [], "--- a.txt\n+++ a.txt\n@@ -1 +1 @@\n-z\n+y\n", "stdin", null, 1, "error: no-match a.txt\nfailed: 1 of 1 edits\n", { "a.txt": "a\nb\n" }),
  adv("uni-hunk-fails-atomic", { "a.txt": "a\nb\n" }, [], "--- a.txt\n+++ a.txt\n@@ -1 +1 @@\n-a\n+A\n@@ -2 +2 @@\n-z\n+y\n", "stdin", null, 1, "error: no-match a.txt\nfailed: 1 of 1 edits\n", { "a.txt": "a\nb\n" }),
  adv("uni-create-exists", { "n.txt": "x\n" }, [], "--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1 @@\n+y\n", "stdin", null, 1, "error: exists n.txt\nfailed: 1 of 1 edits\n", { "n.txt": "x\n" }),
  adv("uni-change-missing", {}, [], "--- a.txt\n+++ a.txt\n@@ -1 +1 @@\n-a\n+b\n", "stdin", null, 1, "error: missing a.txt\nfailed: 1 of 1 edits\n", {}),
  adv("uni-delete-missing", {}, [], "--- a.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-a\n", "stdin", null, 1, "error: missing a.txt\nfailed: 1 of 1 edits\n", {}),
  adv("uni-move-exists", { "a.txt": "a\n", "b.txt": "b\n" }, [], "diff --git a/a.txt b/b.txt\nrename from a.txt\nrename to b.txt\n@@ -1 +1 @@\n-a\n+A\n", "stdin", null, 1, "error: exists b.txt\nfailed: 1 of 1 edits\n", { "a.txt": "a\n", "b.txt": "b\n" }),
  adv("uni-move-missing", {}, [], "diff --git a/a.txt b/b.txt\nrename from a.txt\nrename to b.txt\n@@ -1 +1 @@\n-a\n+A\n", "stdin", null, 1, "error: missing a.txt\nfailed: 1 of 1 edits\n", {}),
  adv("uni-unsafe-path", {}, [], "--- /dev/null\n+++ b/../evil.txt\n@@ -0,0 +1 @@\n+x\n", "stdin", null, 1, "error: unsafe ../evil.txt\nfailed: 1 of 1 edits\n", {}),
  adv("uni-unsafe-abs", {}, [], "--- /dev/null\n+++ /etc/x.txt\n@@ -0,0 +1 @@\n+x\n", "stdin", null, 1, "error: unsafe /etc/x.txt\nfailed: 1 of 1 edits\n", {}),
  adv("uni-no-change-listed", { "a.txt": "a\nb\n" }, [], "--- a.txt\n+++ a.txt\n@@ -1 +1 @@\n-a\n+a\n", "stdin", null, 0, "ok: 0 files\n", { "a.txt": "a\nb\n" }),

  // --- search/replace (14) ---
  adv("sr-basic", { "a.txt": "hello\nworld\n" }, [], "a.txt\n<<<<<<< SEARCH\nhello\n=======\ngoodbye\n>>>>>>> REPLACE\n", "stdin", null, 0, "M a.txt\nok: 1 file\n", { "a.txt": "goodbye\nworld\n" }),
  adv("sr-path-after-fence", { "a.txt": "hello\nworld\n" }, [], "```\ncode\n```\na.txt\n<<<<<<< SEARCH\nhello\n=======\ngoodbye\n>>>>>>> REPLACE\n", "stdin", null, 0, "M a.txt\nok: 1 file\n", { "a.txt": "goodbye\nworld\n" }),
  adv("sr-second-block-inherits-path", { "a.txt": "one\ntwo\n" }, [], "a.txt\n<<<<<<< SEARCH\none\n=======\nuno\n>>>>>>> REPLACE\n<<<<<<< SEARCH\ntwo\n=======\ndos\n>>>>>>> REPLACE\n", "stdin", null, 0, "M a.txt\nok: 1 file\n", { "a.txt": "uno\ndos\n" }),
  adv("sr-first-block-no-path", {}, [], "<<<<<<< SEARCH\none\n=======\nuno\n>>>>>>> REPLACE\n", "stdin", null, 2, "error: parse 1\n", {}),
  adv("sr-missing-separator", {}, [], "a.txt\n<<<<<<< SEARCH\none\n>>>>>>> REPLACE\n", "stdin", null, 2, "error: parse 2\n", {}),
  adv("sr-create-empty-old", {}, [], "n.txt\n<<<<<<< SEARCH\n=======\nhello\n>>>>>>> REPLACE\n", "stdin", null, 0, "A n.txt\nok: 1 file\n", { "n.txt": "hello\n" }),
  adv("sr-create-exists", { "n.txt": "x\n" }, [], "n.txt\n<<<<<<< SEARCH\n=======\nhello\n>>>>>>> REPLACE\n", "stdin", null, 1, "error: exists n.txt\nfailed: 1 of 1 edits\n", { "n.txt": "x\n" }),
  adv("sr-ambiguous", { "a.txt": "x\nx\n" }, [], "a.txt\n<<<<<<< SEARCH\nx\n=======\ny\n>>>>>>> REPLACE\n", "stdin", null, 1, "error: ambiguous a.txt\nfailed: 1 of 1 edits\n", { "a.txt": "x\nx\n" }),
  adv("sr-no-match", { "a.txt": "x\n" }, [], "a.txt\n<<<<<<< SEARCH\nz\n=======\ny\n>>>>>>> REPLACE\n", "stdin", null, 1, "error: no-match a.txt\nfailed: 1 of 1 edits\n", { "a.txt": "x\n" }),
  adv("sr-missing", {}, [], "a.txt\n<<<<<<< SEARCH\nx\n=======\ny\n>>>>>>> REPLACE\n", "stdin", null, 1, "error: missing a.txt\nfailed: 1 of 1 edits\n", {}),
  adv("sr-tier1-trailing", { "a.txt": "one\ntwo  \nthree\n" }, [], "a.txt\n<<<<<<< SEARCH\ntwo\n=======\nTWO\n>>>>>>> REPLACE\n", "stdin", null, 0, "M a.txt\nok: 1 file\n", { "a.txt": "one\nTWO\nthree\n" }),
  adv("sr-context-reindent-tier2", { "a.txt": "  one\n  two\n" }, [], "a.txt\n<<<<<<< SEARCH\none\ntwo\n=======\none\nTWO\n>>>>>>> REPLACE\n", "stdin", null, 0, "M a.txt\nok: 1 file\n", { "a.txt": "  one\n  TWO\n" }),
  adv("sr-outside-ignored", { "a.txt": "one\n" }, [], "prose here\na.txt\n<<<<<<< SEARCH\none\n=======\nuno\n>>>>>>> REPLACE\nmore prose\n", "stdin", null, 0, "M a.txt\nok: 1 file\n", { "a.txt": "uno\n" }),
  adv("sr-path-with-spaces-trimmed", { "a.txt": "one\n" }, [], "  a.txt  \n<<<<<<< SEARCH\none\n=======\nuno\n>>>>>>> REPLACE\n", "stdin", null, 0, "M a.txt\nok: 1 file\n", { "a.txt": "uno\n" }),

  // --- v4a (16) ---
  adv("v4a-basic-update", { "a.txt": "one\ntwo\nthree\n" }, [], "*** Begin Patch\n*** Update File: a.txt\n one\n-two\n+TWO\n three\n*** End Patch\n", "stdin", null, 0, "M a.txt\nok: 1 file\n", { "a.txt": "one\nTWO\nthree\n" }),
  adv("v4a-missing-begin", {}, [], "*** Update File: a.txt\n one\n*** End Patch\n", "stdin", null, 2, "error: format\n", {}),
  adv("v4a-format-flag-no-begin", {}, ["--format=v4a"], "*** Update File: a.txt\n*** End Patch\n", "stdin", null, 2, "error: parse 1\n", {}),
  adv("v4a-missing-end", {}, [], "*** Begin Patch\n*** Update File: a.txt\n one\n", "stdin", null, 2, "error: parse 4\n", {}),
  adv("v4a-add", {}, [], "*** Begin Patch\n*** Add File: n.txt\n+hello\n+world\n*** End Patch\n", "stdin", null, 0, "A n.txt\nok: 1 file\n", { "n.txt": "hello\nworld\n" }),
  adv("v4a-add-empty-line", {}, [], "*** Begin Patch\n*** Add File: n.txt\n+hello\n\n+world\n*** End Patch\n", "stdin", null, 0, "A n.txt\nok: 1 file\n", { "n.txt": "hello\n\nworld\n" }),
  adv("v4a-add-exists", { "n.txt": "x\n" }, [], "*** Begin Patch\n*** Add File: n.txt\n+hello\n*** End Patch\n", "stdin", null, 1, "error: exists n.txt\nfailed: 1 of 1 edits\n", { "n.txt": "x\n" }),
  adv("v4a-delete", { "a.txt": "x\n" }, [], "*** Begin Patch\n*** Delete File: a.txt\n*** End Patch\n", "stdin", null, 0, "D a.txt\nok: 1 file\n", {}),
  adv("v4a-delete-missing", {}, [], "*** Begin Patch\n*** Delete File: a.txt\n*** End Patch\n", "stdin", null, 1, "error: missing a.txt\nfailed: 1 of 1 edits\n", {}),
  adv("v4a-move", { "a.txt": "one\ntwo\n" }, [], "*** Begin Patch\n*** Update File: a.txt\n*** Move to: b.txt\n one\n-two\n+TWO\n*** End Patch\n", "stdin", null, 0, "R a.txt -> b.txt\nok: 1 file\n", { "b.txt": "one\nTWO\n" }),
  adv("v4a-move-only", { "a.txt": "x\n" }, [], "*** Begin Patch\n*** Update File: a.txt\n*** Move to: b.txt\n*** End Patch\n", "stdin", null, 0, "R a.txt -> b.txt\nok: 1 file\n", { "b.txt": "x\n" }),
  adv("v4a-update-no-chunk-no-move", {}, [], "*** Begin Patch\n*** Update File: a.txt\n*** End Patch\n", "stdin", null, 2, "error: parse 2\n", {}),
  adv("v4a-anchor", { "a.txt": "h1\nx\nh2\nx\n" }, [], "*** Begin Patch\n*** Update File: a.txt\n@@ h2\n-x\n+X\n*** End Patch\n", "stdin", null, 0, "M a.txt\nok: 1 file\n", { "a.txt": "h1\nx\nh2\nX\n" }),
  adv("v4a-anchor-no-match", { "a.txt": "h1\nx\nh2\nx\n" }, [], "*** Begin Patch\n*** Update File: a.txt\n@@ h9\n-x\n+X\n*** End Patch\n", "stdin", null, 1, "error: no-match a.txt\nfailed: 1 of 1 edits\n", { "a.txt": "h1\nx\nh2\nx\n" }),
  adv("v4a-eof-chunk", { "a.txt": "one\ntwo\n" }, [], "*** Begin Patch\n*** Update File: a.txt\n@@\n-two\n+TWO\n*** End of File\n*** End Patch\n", "stdin", null, 0, "M a.txt\nok: 1 file\n", { "a.txt": "one\nTWO\n" }),
  adv("v4a-eof-chunk-no-match", { "a.txt": "one\ntwo\nthree\n" }, [], "*** Begin Patch\n*** Update File: a.txt\n@@\n-two\n+TWO\n*** End of File\n*** End Patch\n", "stdin", null, 1, "error: no-match a.txt\nfailed: 1 of 1 edits\n", { "a.txt": "one\ntwo\nthree\n" }),
  adv("v4a-cursor-advance", { "a.txt": "a\nb\na\nb\n" }, [], "*** Begin Patch\n*** Update File: a.txt\n@@\n-a\n+A\n@@\n-b\n+B\n*** End Patch\n", "stdin", null, 0, "M a.txt\nok: 1 file\n", { "a.txt": "A\nB\na\nb\n" }),

  // --- json (14) ---
  adv("json-create", {}, [], '[{"command":"create","path":"n.txt","file_text":"hi\\n"}]', "stdin", null, 0, "A n.txt\nok: 1 file\n", { "n.txt": "hi\n" }),
  adv("json-create-raw-bytes", {}, [], '[{"command":"create","path":"n.txt","file_text":"a\\r\\nb"}]', "stdin", null, 0, "A n.txt\nok: 1 file\n", { "n.txt": "a\r\nb" }),
  adv("json-create-exists", { "n.txt": "x" }, [], '[{"command":"create","path":"n.txt","file_text":"y"}]', "stdin", null, 1, "error: exists n.txt\nfailed: 1 of 1 edits\n", { "n.txt": "x" }),
  adv("json-str-replace", { "a.txt": "hello world\n" }, [], '[{"command":"str_replace","path":"a.txt","old_str":"world","new_str":"there"}]', "stdin", null, 0, "M a.txt\nok: 1 file\n", { "a.txt": "hello there\n" }),
  adv("json-str-replace-ambiguous", { "a.txt": "x x\n" }, [], '[{"command":"str_replace","path":"a.txt","old_str":"x","new_str":"y"}]', "stdin", null, 1, "error: ambiguous a.txt\nfailed: 1 of 1 edits\n", { "a.txt": "x x\n" }),
  adv("json-str-replace-no-match", { "a.txt": "x\n" }, [], '[{"command":"str_replace","path":"a.txt","old_str":"z","new_str":"y"}]', "stdin", null, 1, "error: no-match a.txt\nfailed: 1 of 1 edits\n", { "a.txt": "x\n" }),
  adv("json-str-replace-crlf", { "a.txt": "one\r\ntwo\r\n" }, [], '[{"command":"str_replace","path":"a.txt","old_str":"two","new_str":"TWO"}]', "stdin", null, 0, "M a.txt\nok: 1 file\n", { "a.txt": "one\r\nTWO\r\n" }),
  adv("json-str-replace-overlap", { "a.txt": "aaa\n" }, [], '[{"command":"str_replace","path":"a.txt","old_str":"aa","new_str":"b"}]', "stdin", null, 1, "error: ambiguous a.txt\nfailed: 1 of 1 edits\n", { "a.txt": "aaa\n" }),
  adv("json-insert", { "a.txt": "one\ntwo\nthree\n" }, [], '[{"command":"insert","path":"a.txt","insert_line":1,"new_str":"uno"}]', "stdin", null, 0, "M a.txt\nok: 1 file\n", { "a.txt": "one\nuno\ntwo\nthree\n" }),
  adv("json-insert-top", { "a.txt": "one\ntwo\nthree\n" }, [], '[{"command":"insert","path":"a.txt","insert_line":0,"new_str":"uno"}]', "stdin", null, 0, "M a.txt\nok: 1 file\n", { "a.txt": "uno\none\ntwo\nthree\n" }),
  adv("json-insert-end", { "a.txt": "one\ntwo\nthree\n" }, [], '[{"command":"insert","path":"a.txt","insert_line":3,"new_str":"uno"}]', "stdin", null, 0, "M a.txt\nok: 1 file\n", { "a.txt": "one\ntwo\nthree\nuno\n" }),
  adv("json-insert-out-of-range", { "a.txt": "one\ntwo\nthree\n" }, [], '[{"command":"insert","path":"a.txt","insert_line":4,"new_str":"uno"}]', "stdin", null, 1, "error: no-match a.txt\nfailed: 1 of 1 edits\n", { "a.txt": "one\ntwo\nthree\n" }),
  adv("json-insert-multiline", { "a.txt": "one\ntwo\n" }, [], '[{"command":"insert","path":"a.txt","insert_line":1,"new_str":"a\\nb"}]', "stdin", null, 0, "M a.txt\nok: 1 file\n", { "a.txt": "one\na\nb\ntwo\n" }),
  adv("json-bad-command", {}, [], '{"command":"explode","path":"a.txt"}', "stdin", null, 2, "error: parse 1\n", {}),

  // --- atomicity / order / --check (8) ---
  adv("ord-create-then-change", {}, [], "--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1 @@\n+hello\n--- n.txt\n+++ n.txt\n@@ -1 +1 @@\n-hello\n+HELLO\n", "stdin", null, 0, "A n.txt\nok: 1 file\n", { "n.txt": "HELLO\n" }),
  adv("ord-fail-then-succeed", {}, [], "--- ghost.txt\n+++ ghost.txt\n@@ -1 +1 @@\n-a\n+b\n--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1 @@\n+hi\n", "stdin", null, 1, "error: missing ghost.txt\nfailed: 1 of 2 edits\n", {}),
  adv("ord-delete-then-create-same", { "a.txt": "old\n" }, [], "--- a.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\n--- /dev/null\n+++ b/a.txt\n@@ -0,0 +1 @@\n+new\n", "stdin", null, 0, "M a.txt\nok: 1 file\n", { "a.txt": "new\n" }),
  adv("ord-create-then-delete-same", {}, [], "--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1 @@\n+hi\n--- n.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-hi\n", "stdin", null, 0, "ok: 0 files\n", {}),
  adv("chk-check-flag", { "a.txt": "one\n" }, ["--check"], "--- a.txt\n+++ a.txt\n@@ -1 +1 @@\n-one\n+ONE\n", "stdin", null, 0, "M a.txt\nok: 1 file\n", { "a.txt": "one\n" }),
  adv("ord-strict-no-match", { "a.txt": "one\ntwo\nthree\n" }, ["--strict"], "--- a.txt\n+++ a.txt\n@@ -1,3 +1,3 @@\n one\n-two \n+TWO\n three\n", "stdin", null, 1, "error: no-match a.txt\nfailed: 1 of 1 edits\n", { "a.txt": "one\ntwo\nthree\n" }),
  adv("ord-multi-failures", { "b.txt": "x\n" }, [], "--- a.txt\n+++ a.txt\n@@ -1 +1 @@\n-a\n+b\n--- /dev/null\n+++ b/b.txt\n@@ -0,0 +1 @@\n+y\n", "stdin", null, 1, "error: missing a.txt\nerror: exists b.txt\nfailed: 2 of 2 edits\n", { "b.txt": "x\n" }),
  adv("ord-unsafe-first", {}, [], "--- ../x.txt\n+++ ../x.txt\n@@ -1 +1 @@\n-a\n+b\n", "stdin", null, 1, "error: unsafe ../x.txt\nfailed: 1 of 1 edits\n", {}),
];

// ------------------------------------------------------------------- driver

function main(): void {
  let failed = false;

  console.log(`== practice trials ==`);
  const first = runPractice();
  for (const t of first.perTrial) {
    const score = Math.round((1000 * t.passed) / t.total);
    const groups = Object.entries(t.groups)
      .map(([g, [p, n]]) => `${g} ${p}/${n}`)
      .join(", ");
    console.log(`trial-${t.trial}: ${t.passed}/${t.total} score ${score} (${groups})`);
    if (t.passed !== t.total) failed = true;
  }

  console.log(`== adversarial (${ADV.length} cases) ==`);
  let advPassed = 0;
  for (const c of ADV) {
    const got = runAdv(c);
    const problems = diffOutcome(got, c.want);
    if (problems.length === 0) {
      advPassed++;
    } else {
      failed = true;
      console.log(`${c.name} FAILED`);
      for (const p of problems) console.log(`  ${p}`);
    }
  }
  console.log(`adversarial: ${advPassed}/${ADV.length}`);

  console.log(`== determinism (practice twice, byte-identical) ==`);
  const second = runPractice();
  const deterministic = first.serialized === second.serialized;
  console.log(deterministic ? "deterministic: yes" : "deterministic: NO");
  if (!deterministic) failed = true;

  if (failed) {
    console.log("RESULT: FAIL");
    process.exit(1);
  }
  console.log("RESULT: ALL PASS");
}

main();
