import { slippageDriftBps } from "../src/ops/drift.js";

const [quoted, mark] = process.argv.slice(2).map(Number);
const drift = slippageDriftBps(quoted ?? NaN, mark ?? NaN);
if (drift == null) {
  console.error("usage: npm run drift -- <quotedUsd> <markUsd>");
  process.exit(1);
}
console.log(`paper_vs_quote quotedUsd=${quoted} markUsd=${mark} drift_bps=${drift}`);
