/**
 * Flags "sleep, then assert" in test files: a short fixed sleep directly
 * followed by `expect(` stands in for "wait until X happened" and flakes on a
 * slow runner. Poll with `until()` from src/__tests__/_wait.ts instead.
 *
 * A fixed settle is right before a negative assert ("nothing happened"); mark
 * those lines with a `// settle:` comment and they pass.
 *
 *   bun scripts/check-test-sleeps.ts [dir]
 */
import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";

const MAX_MS = 200;
const root = process.argv[2] ?? join(import.meta.dir, "..", "src", "__tests__");

// `await sleep(20)`, `await Bun.sleep(20)`, `await new Promise((r) => setTimeout(r, 20))`
// at the start of a line: a statement of its own, not a poll loop or hook code
// inside a string.
const SLEEP = /^\s*await\s+(?:(?:Bun\.)?sleep\(\s*([\d_]+)\s*\)|new\s+Promise\(\s*\(?\s*(\w+)\s*\)?\s*=>\s*setTimeout\(\s*\2\s*,\s*([\d_]+)\s*\)\s*\))/;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === "node_modules" ? [] : files(p);
    return name.endsWith(".test.ts") ? [p] : [];
  });
}

const problems: string[] = [];
for (const file of files(root)) {
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    const m = SLEEP.exec(line);
    if (!m || line.includes("// settle:")) return;
    const ms = Number((m[1] ?? m[3])!.replace(/_/g, ""));
    if (ms > MAX_MS) return;
    let j = i + 1;
    while (j < lines.length && /^\s*(\/\/.*)?$/.test(lines[j]!)) j++;
    if (j < lines.length && /^\s*expect\(/.test(lines[j]!)) {
      problems.push(`${relative(process.cwd(), file)}:${i + 1}: sleep(${ms}) then expect: poll with until(), or mark a negative-assert settle with "// settle: <why>"`);
    }
  });
}

if (problems.length) {
  console.error(problems.join("\n"));
  console.error(`\n${problems.length} sleep-then-assert line(s).`);
  process.exit(1);
}
console.log("check-test-sleeps: ok");
