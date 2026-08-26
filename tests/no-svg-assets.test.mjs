import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));

function listedFiles(pathspecs) {
  const output = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "--", ...pathspecs],
    { cwd: repoRoot, encoding: "utf8" },
  );

  return output
    .split("\n")
    .map((entry) => entry.trim())
    .filter((entry) => entry && existsSync(fileURLToPath(new URL(entry, `file://${repoRoot}/`))));
}

test("the application ships no SVG source files", () => {
  const svgFiles = listedFiles(["*.svg", "*.SVG"]);
  assert.deepEqual(svgFiles, [], `Remove SVG assets: ${svgFiles.join(", ")}`);
});

test("application components contain no inline SVG markup", () => {
  const sourceFiles = listedFiles(["app", "components"]).filter((file) =>
    /\.(?:[cm]?[jt]sx?|html?)$/i.test(file),
  );
  const offenders = sourceFiles.filter((file) => {
    const source = readFileSync(fileURLToPath(new URL(file, `file://${repoRoot}/`)), "utf8");
    return /<\s*svg\b/i.test(source);
  });

  assert.deepEqual(offenders, [], `Replace inline SVG markup: ${offenders.join(", ")}`);
});
