import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair } from "@solana/web3.js";
import { closeEmptyTokenAccount } from "../src/execution/closeAta.js";
import { BaseExecutor } from "../src/execution/base.js";
import { SolanaExecutor } from "../src/execution/solana.js";
import { loadAppConfig, type EnvConfig } from "../src/config.js";
import { PriceService } from "../src/utils/prices.js";
import { TOKEN_PROGRAM_ID } from "../src/security/simulateSwap.js";
import type { Connection } from "@solana/web3.js";
import { classifySellSimulation } from "../src/security/sellSim.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "src");

const CALLS = [
  { name: ".sign(", re: /\.sign\s*\(/g },
  { name: "sendTransaction", re: /\bsendTransaction\s*\(/g },
  { name: "sendRawTransaction", re: /\bsendRawTransaction\s*\(/g },
  { name: "sendAndConfirmTransaction", re: /\bsendAndConfirmTransaction\s*\(/g },
  { name: "writeContract", re: /\.writeContract\s*\(/g },
  { name: "signTransaction", re: /\bsignTransaction\s*\(/g },
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** Split a source file into function bodies. A call must see assertLiveAllowed earlier in that body. */
function functionBodies(source: string): string[] {
  const bodies: string[] = [];
  const start = /^(?:export\s+)?(?:async\s+)?function\s+\w+|^[ \t]+(?:public |private |protected )?(?:async\s+)?\w+\s*\([^;]*\)\s*(?::[^{]+)?\{/gm;
  const indexes: number[] = [];
  let match: RegExpExecArray | null;
  while ((match = start.exec(source))) {
    if (source.slice(match.index, match.index + 80).includes("=>")) continue;
    indexes.push(match.index);
  }
  for (let i = 0; i < indexes.length; i++) {
    const from = indexes[i]!;
    const to = indexes[i + 1] ?? source.length;
    bodies.push(source.slice(from, to));
  }
  return bodies;
}

describe("sign and send sites call the dry-run guard", () => {
  it("every sign or send in src is preceded by assertLiveAllowed in the same function", () => {
    const missing: string[] = [];
    for (const file of walk(src)) {
      const text = fs.readFileSync(file, "utf8");
      const rel = path.relative(root, file);
      for (const body of functionBodies(text)) {
        for (const call of CALLS) {
          const re = new RegExp(call.re.source, "g");
          let found: RegExpExecArray | null;
          while ((found = re.exec(body))) {
            const before = body.slice(0, found.index);
            if (!before.includes("assertLiveAllowed(")) {
              const line = body.slice(0, found.index).split("\n").length;
              missing.push(`${rel}: ${call.name} around function line ${line}`);
            }
          }
        }
      }
    }
    assert.deepEqual(missing, []);
  });

  it("reclaimRent throws under DRY_RUN and does not send", async () => {
    const prev = process.env.DRY_RUN;
    delete process.env.DRY_RUN;
    let sent = 0;
    const owner = Keypair.generate();
    let reads = 0;
    const connection = {
      getAccountInfo: async () => {
        reads++;
        if (reads === 1) {
          return { owner: TOKEN_PROGRAM_ID, data: Buffer.alloc(0), lamports: 1 };
        }
        return { owner: TOKEN_PROGRAM_ID, data: Buffer.alloc(165), lamports: 2_039_280 };
      },
    } as unknown as Connection;
    try {
      await assert.rejects(
        () =>
          closeEmptyTokenAccount({
            rpcUrl: "https://rpc.example",
            owner,
            mint: "So11111111111111111111111111111111111111112",
            connection,
            send: async () => {
              sent++;
              return "sig";
            },
          }),
        /DRY_RUN guard/,
      );
      assert.equal(sent, 0);
      const cfg = loadAppConfig(path.join(root, "config.example.yaml"));
      const env: EnvConfig = {
        fomoApiKey: "",
        dryRun: true,
        solanaRpcUrl: "http://127.0.0.1:1",
        solanaPrivateKey: JSON.stringify(Array.from(owner.secretKey)),
        jupiterApiKey: "",
        baseRpcUrl: "",
        basePrivateKey: "",
        zeroXApiKey: "",
        telegramBotToken: "",
        telegramChatId: "",
        telegramAllowedUserIds: [],
        configPath: "",
        dataDir: path.join(root, "data", "test-guard-rent"),
        killSwitchPath: path.join(root, "data", "test-guard-rent", "k"),
      };
      const exec = new SolanaExecutor(env, cfg, new PriceService({}));
      await assert.rejects(() => exec.reclaimRent("So11111111111111111111111111111111111111112"), /DRY_RUN guard/);
    } finally {
      if (prev === undefined) delete process.env.DRY_RUN;
      else process.env.DRY_RUN = prev;
    }
  });

  it("Base approve throws under DRY_RUN and does not writeContract", async () => {
    const prev = process.env.DRY_RUN;
    delete process.env.DRY_RUN;
    let writes = 0;
    const cfg = loadAppConfig(path.join(root, "config.example.yaml"));
    cfg.chains.base = true;
    const env: EnvConfig = {
      fomoApiKey: "",
      dryRun: true,
      solanaRpcUrl: "",
      solanaPrivateKey: "",
      jupiterApiKey: "",
      baseRpcUrl: "https://mainnet.base.org",
      basePrivateKey: "0x" + "11".repeat(32),
      zeroXApiKey: "test",
      telegramBotToken: "",
      telegramChatId: "",
      telegramAllowedUserIds: [],
      configPath: "",
      dataDir: path.join(root, "data", "test-guard-base"),
      killSwitchPath: path.join(root, "data", "test-guard-base", "k"),
    };
    try {
      const base = new BaseExecutor(env, cfg, new PriceService({}));
      const wallet = (base as unknown as { walletClient: { writeContract: () => Promise<string> } }).walletClient;
      wallet.writeContract = async () => {
        writes++;
        return "0xabc";
      };
      const reader = (base as unknown as {
        publicClient: { readContract: () => Promise<bigint> };
      }).publicClient;
      reader.readContract = async () => 0n;
      await assert.rejects(
        () =>
          (
            base as unknown as {
              ensureAllowance: (token: string, spender: string, amount: bigint) => Promise<void>;
            }
          ).ensureAllowance("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", "0x0000000000000000000000000000000000000001", 10n),
        /DRY_RUN guard/,
      );
      assert.equal(writes, 0);
    } finally {
      if (prev === undefined) delete process.env.DRY_RUN;
      else process.env.DRY_RUN = prev;
    }
  });
});

describe("InvalidAccountData is not a honeypot", () => {
  it("classifies an uninitialized sell-leg account as inconclusive", () => {
    assert.equal(
      classifySellSimulation({ InstructionError: [7, "InvalidAccountData"] }),
      "inconclusive",
    );
    assert.equal(
      classifySellSimulation({ InstructionError: [4, "AccountNotInitialized"] }, ["UninitializedAccount"]),
      "inconclusive",
    );
    assert.equal(
      classifySellSimulation({ InstructionError: [1, "Custom"] }, ["Error: NonTransferable"]),
      "honeypot",
    );
    assert.equal(
      classifySellSimulation({ InstructionError: [1, { Custom: 17 }] }, ["non-transferable"]),
      "honeypot",
    );
  });
});
