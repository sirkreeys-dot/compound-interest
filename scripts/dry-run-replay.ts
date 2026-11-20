/**
 * Replay fixture alerts through the copy engine with DRY_RUN forced on.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDataDir, loadAppConfig, loadEnv } from "../src/config.js";
import { CopyEngine } from "../src/engine/copy.js";
import { Watchlist } from "../src/engine/watchlist.js";
import { ExecutionRouter } from "../src/execution/index.js";
import { parseAlert } from "../src/fomo/adapter.js";
import { TelegramNotifier } from "../src/notify/telegram.js";
import { Store } from "../src/store/db.js";
import { KillSwitch } from "../src/utils/killswitch.js";
import { log, setLogLevel } from "../src/utils/logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

async function main(): Promise<void> {
  process.env.DRY_RUN = "true";
  const env = loadEnv();
  env.dryRun = true;

  const configPath = fs.existsSync(path.join(root, "config.yaml"))
    ? path.join(root, "config.yaml")
    : path.join(root, "config.example.yaml");
  const cfg = loadAppConfig(configPath, env);
  // Replay uses manual fixture traders (no API key required)
  cfg.traderSource = "manual";
  cfg.traders = [
    {
      handle: "frankdegods",
      userId: "6dcf7c78-2537-522a-8307-3f9970c081be",
      enabled: true,
      chains: ["solana", "base"],
    },
  ];
  setLogLevel("info");

  const dataDir = path.join(root, "data", "replay");
  ensureDataDir(dataDir);
  for (const f of fs.readdirSync(dataDir)) {
    fs.unlinkSync(path.join(dataDir, f));
  }

  const store = new Store(dataDir);
  const kill = new KillSwitch(path.join(dataDir, "kill.switch"));
  const tg = new TelegramNotifier("", "");
  const exec = new ExecutionRouter(env, cfg);
  const watchlist = new Watchlist(cfg, null, undefined, store);
  await watchlist.start();
  const engine = new CopyEngine({ ...env, dryRun: true }, cfg, store, exec, kill, tg, watchlist);

  const fixturePath = path.join(root, "fixtures", "sample-alerts.json");
  const raw = JSON.parse(fs.readFileSync(fixturePath, "utf8")) as unknown[];
  log.info(`Replaying ${raw.length} fixture alerts (size=$${cfg.sizing.fixedUsd})…`);
  for (const item of raw) {
    const alert = parseAlert(item);
    if (!alert) {
      log.warn("Could not parse fixture item", item);
      continue;
    }
    await engine.handleAlert(alert);
  }
  const liveOpen = store.listOpen();
  const open = store.listOpen({ includeDryRun: true });
  log.info(
    `Open positions after replay: ${open.length} including dry-run (${liveOpen.length} live)`,
  );
  log.info(`Daily stats (live only): ${JSON.stringify(store.getDaily())}`);
  store.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
