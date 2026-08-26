#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import {
  findRuntimeGlbFiles,
  validateRuntimeGlbFile,
} from "./lib/runtime-glb-validation.mjs";

async function main() {
  const root = path.resolve(process.argv[2] ?? "public/assets");
  const files = await findRuntimeGlbFiles(root);
  if (files.length === 0) throw new Error(`No runtime GLBs found under ${root}`);

  let totalBytes = 0;
  let totalAnimations = 0;
  for (const file of files) {
    const result = await validateRuntimeGlbFile(file);
    totalBytes += result.byteLength;
    totalAnimations += result.animations;
    console.log(
      `valid ${path.relative(process.cwd(), file)} ` +
        `(${result.byteLength.toLocaleString()} bytes, ${result.animations} animations)`,
    );
  }
  console.log(
    `Validated ${files.length} self-contained runtime GLBs ` +
      `(${totalBytes.toLocaleString()} bytes, ${totalAnimations} animations).`,
  );
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
