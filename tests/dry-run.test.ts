import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadAppConfig } from "../src/config.js";
import { CopyEngine } from "../src/engine/copy.js";
import { Watchlist } from "../src/engine/watchlist.js";
import { ExecutionRouter } from "../src/execution/index.js";
import { parseAlert } from "../src/fomo/adapter.js";
import { TelegramNotifier } from "../src/notify/telegram.js";
import { Store } from "../src/store/db.js";
import { KillSwitch } from "../src/utils/killswitch.js";
import type { EnvConfig } from "../src/config.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("dry-run engine with fixtures", () => {
  it("processes sample alerts without throwing", async () => {
    const dir = path.join(root, "data", "test-dryrun");
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const cfg = loadAppConfig(path.join(root, "config.example.yaml"));
    cfg.traderSource = "manual";
    cfg.traders = [
      {
        handle: "frankdegods",
        userId: "6dcf7c78-2537-522a-8307-3f9970c081be",
        enabled: true,
        chains: ["solana", "base"],
      },
    ];
    cfg.sizing.minTraderTradeUsd = 50;
    const env: EnvConfig = {
      fomoApiKey: "",
      dryRun: true,
      solanaRpcUrl: "https://api.mainnet-beta.solana.com",
      solanaPrivateKey: "",
      jupiterApiKey: "",
      baseRpcUrl: "https://mainnet.base.org",
      basePrivateKey: "",
      zeroXApiKey: "",
      telegramBotToken: "",
      telegramChatId: "",
      configPath: path.join(root, "config.example.yaml"),
      dataDir: dir,
      killSwitchPath: path.join(dir, "kill.switch"),
      telegramAllowedUserIds: [],
    };
    const store = new Store(dir);
    const kill = new KillSwitch(env.killSwitchPath);
    const tg = new TelegramNotifier("", "");
    const exec = new ExecutionRouter(env, cfg);
    const watchlist = new Watchlist(cfg, null, undefined, store);
    await watchlist.start();
    const engine = new CopyEngine(env, cfg, store, exec, kill, tg, watchlist);

    const fixtures = JSON.parse(
      fs.readFileSync(path.join(root, "fixtures", "sample-alerts.json"), "utf8"),
    ) as unknown[];

    for (const item of fixtures) {
      const alert = parseAlert(item);
      if (!alert) continue;
      await engine.handleAlert(alert);
    }

    const open = store.listOpen();
    assert.ok(Array.isArray(open));
    store.close();
  });
});
