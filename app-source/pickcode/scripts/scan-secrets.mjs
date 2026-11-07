import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const allowedFileExtensions = new Set([
  ".js",
  ".mjs",
  ".json",
  ".md",
  ".yml",
  ".yaml"
]);
const excludedDirectories = new Set([".git", "node_modules"]);
const suspiciousPatterns = [
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bghp_[A-Za-z0-9_]{30,}\b/,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/,
  /\bsk-[A-Za-z0-9]{32,}\b/,
  /(?:password|passwd|api[_-]?key|secret|token)\s*[:=]\s*['"][^'"]{12,}['"]/i
];

const listed = spawnSync("rg", ["--files"], {
  cwd: projectRoot,
  encoding: "utf8",
  shell: false
});

if (listed.status !== 0) {
  process.stderr.write(listed.stderr || "Unable to list files with rg\n");
  process.exit(1);
}

const findings = [];
for (const relativePath of listed.stdout.trim().split(/\r?\n/).filter(Boolean)) {
  const segments = relativePath.split(/[\\/]/);
  if (segments.some((segment) => excludedDirectories.has(segment))) {
    continue;
  }
  if (!allowedFileExtensions.has(path.extname(relativePath))) {
    continue;
  }

  const content = await readFile(path.join(projectRoot, relativePath), "utf8");
  const lines = content.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (suspiciousPatterns.some((pattern) => pattern.test(line))) {
      findings.push(`${relativePath}:${index + 1}`);
    }
  }
}

if (findings.length > 0) {
  process.stderr.write(`Potential secrets found:\n${findings.join("\n")}\n`);
  process.exit(1);
}

process.stdout.write("PASS secret scan\n");
