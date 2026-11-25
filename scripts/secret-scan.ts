/**
 * Fail if a tracked file contains a live-looking secret.
 * Does not print the matching value.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const patterns: Array<{ name: string; re: RegExp }> = [
  { name: "fomo-key", re: /fapi_[A-Za-z0-9]{8,}/ },
  { name: "alchemy-path", re: /alchemy\.com\/v2\/[A-Za-z0-9]{8,}/ },
  { name: "telegram-token", re: /bot\d+:[A-Za-z0-9_-]{20,}/ },
  { name: "labeled-private-key", re: /(?:SOLANA|BASE)_PRIVATE_KEY\s*[:=]\s*\S{20,}/ },
];

const files = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" })
  .split("\n")
  .map((line) => line.trim())
  .filter(Boolean);

let hits = 0;
for (const file of files) {
  if (file === "scripts/secret-scan.ts" || file.endsWith(".md")) continue;
  const text = fs.readFileSync(path.join(root, file), "utf8");
  for (const pattern of patterns) {
    if (pattern.re.test(text)) {
      hits++;
      console.error(`secret-scan: ${pattern.name} in ${file}`);
    }
  }
}
if (hits) {
  console.error(`secret-scan: ${hits} hit(s)`);
  process.exit(1);
}
console.log(`secret-scan: ${files.length} tracked files, 0 hits`);
