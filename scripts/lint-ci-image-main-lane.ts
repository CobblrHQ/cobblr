#!/usr/bin/env tsx
// Main image jobs use a label that no other workflow may request.
// PR image checks shared the image runner and queued main builds for hours.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export function checkWorkflow(file: string, source: string): string[] {
  const errors: string[] = [];
  const main = file === "docker-build.yml";
  let jobs = 0;
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const match = /^\s*runs-on:\s*(.*?)\s*(?:#.*)?$/.exec(lines[i]!);
    if (!match) continue;
    jobs++;
    let value = match[1]!;
    if (!value) {
      for (let j = i + 1; j < lines.length && /^\s+-\s/.test(lines[j]!); j++) value += ` ${lines[j]}`;
    }
    const matrix = /\$\{\{\s*matrix\.([\w-]+)\s*\}\}/.exec(value);
    if (matrix) value = new RegExp(`^\\s*${matrix[1]}:\\s*\\[([^\\]]*)\\]`, "m").exec(source)?.[1] ?? value;
    const labels = value.replace(/[\[\]"']/g, "").split(/[,\s]+/).filter(label => label && label !== "-");
    if (main && (labels.length !== 1 || labels[0] !== "image-main")) errors.push(`${file}:${i + 1} main image jobs must use image-main`);
    if (!main && labels.includes("image-main")) errors.push(`${file}:${i + 1} image-main belongs to docker-build.yml alone`);
    if (file === "api-image-check.yml" && (labels.length !== 1 || labels[0] !== "image-pr")) errors.push(`${file}:${i + 1} PR image checks must use image-pr`);
  }
  if ((main || file === "api-image-check.yml") && !jobs) errors.push(`${file}: no image jobs found`);
  return errors;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = new URL("../.forgejo/workflows/", import.meta.url).pathname;
  const errors = readdirSync(dir).filter(file => /\.ya?ml$/.test(file)).flatMap(file => checkWorkflow(file, readFileSync(join(dir, file), "utf8")));
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  } else console.log("lint:ci-image-main-lane OK");
}
