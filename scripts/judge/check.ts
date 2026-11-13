// `make judge-check`: every "quoted" button or link label a judge is told to press in JUDGE.md
// ("Do" column of "Check it in 3 minutes") must still exist in the web app's source, so a renamed
// button can't silently break the walkthrough.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const guide = readFileSync(resolve(root, "JUDGE.md"), "utf8");
const section = guide.split("## Check it in 3 minutes")[1]?.split("\n## ")[0] ?? "";
const rows = section.split("\n").filter((l) => l.startsWith("| ") && !/^\|\s*(Do|-)/.test(l));
const labels = rows.flatMap((r) =>
  [...(r.split("|")[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1] ?? ""),
);

const files: string[] = [];
const walk = (d: string) => {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(tsx?|css)$/.test(f)) files.push(p);
  }
};
walk(resolve(root, "apps/web/src"));
// The app writes ’ in labels; the guide may use '.
const norm = (s: string) => s.replaceAll("’", "'");
const source = norm(files.map((f) => readFileSync(f, "utf8")).join("\n"));

let missing = 0;
for (const l of labels) {
  const ok = source.includes(norm(l));
  if (!ok) missing++;
  console.log(`${ok ? "PASS" : "FAIL"}  "${l}"`);
}
if (labels.length === 0) {
  console.log("FAIL  no labels found in JUDGE.md");
  process.exit(1);
}
console.log(
  `\n${labels.length - missing} of ${labels.length} labels in JUDGE.md exist in the app.`,
);
process.exit(missing ? 1 : 0);
