import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { loadAppConfig, type EnvConfig } from "../src/config.js";
import { CopyEngine } from "../src/engine/copy.js";
import { Watchlist } from "../src/engine/watchlist.js";
import { resolveSellFraction, traderHoldState } from "../src/engine/sellFraction.js";
import type { ExecutionRouter } from "../src/execution/index.js";
import { jupiterInUsdAllowed } from "../src/execution/solana.js";
import type { SwapRequest, SwapResult } from "../src/execution/types.js";
import { TelegramNotifier } from "../src/notify/telegram.js";
import {
  FORBIDDEN_TOKEN_DISCRIMINATORS,
  accountKeysFromLoadedMessage,
  inspectSwapInstructions,
} from "../src/security/programAllowlist.js";
import { redactSecrets } from "../src/security/redact.js";
import { evaluateSimulatedBalances, WSOL_MINT } from "../src/security/simulateSwap.js";
import { Store } from "../src/store/db.js";
import { KillSwitch } from "../src/utils/killswitch.js";
import { PriceService } from "../src/utils/prices.js";
import type { NormalizedAlert } from "../src/types.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = path.join(root, "data", "test-audit");
const MINT = "6863YfxMrFZhKidtv7oCcfoL2s6hvnfp7cSnBoKMp1dP";
const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

function v0(payer: Keypair, ix: TransactionInstruction, extraSigner?: PublicKey): VersionedTransaction {
  const msg = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
    instructions: extraSigner
      ? [
          ix,
          SystemProgram.transfer({
            fromPubkey: extraSigner,
            toPubkey: payer.publicKey,
            lamports: 1,
          }),
        ]
      : [ix],
  }).compileToV0Message();
  return new VersionedTransaction(msg);
}

describe("C1 program allowlist and instruction decode", () => {
  const allow = loadAppConfig(path.join(root, "config.example.yaml")).risk.solanaProgramAllowlist;

  it("rejects a top-level program that is not on the allowlist", () => {
    const payer = Keypair.generate();
    const evil = Keypair.generate().publicKey;
    const tx = v0(
      payer,
      new TransactionInstruction({ programId: evil, keys: [], data: Buffer.from([0]) }),
    );
    const keys = accountKeysFromLoadedMessage(tx, []);
    assert.ok(keys);
    const r = inspectSwapInstructions({
      tx,
      accountKeys: keys!,
      ourPubkey: payer.publicKey,
      allowlist: allow,
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /not on the allowlist/);
  });

  it("rejects Approve and a second required signer", () => {
    assert.equal(FORBIDDEN_TOKEN_DISCRIMINATORS.has(4), true);
    const payer = Keypair.generate();
    const delegate = Keypair.generate().publicKey;
    const ata = Keypair.generate().publicKey;
    const tx = v0(
      payer,
      new TransactionInstruction({
        programId: TOKEN,
        keys: [
          { pubkey: ata, isSigner: false, isWritable: true },
          { pubkey: delegate, isSigner: false, isWritable: false },
          { pubkey: payer.publicKey, isSigner: false, isWritable: false },
        ],
        data: Buffer.from([4, 1, 0, 0, 0, 0, 0, 0, 0]),
      }),
    );
    const keys = accountKeysFromLoadedMessage(tx, [])!;
    const r = inspectSwapInstructions({
      tx,
      accountKeys: keys,
      ourPubkey: payer.publicKey,
      allowlist: allow,
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /forbidden token instruction/);

    const other = Keypair.generate();
    const two = v0(
      payer,
      SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: other.publicKey, lamports: 1 }),
      other.publicKey,
    );
    const keys2 = accountKeysFromLoadedMessage(two, [])!;
    const r2 = inspectSwapInstructions({
      tx: two,
      accountKeys: keys2,
      ourPubkey: payer.publicKey,
      allowlist: allow,
    });
    assert.equal(r2.ok, false);
    if (!r2.ok) assert.match(r2.error, /required signers/);
  });

  it("fails closed when lookup-table accounts were not resolved", () => {
    const payer = Keypair.generate();
    const tx = v0(
      payer,
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: Keypair.generate().publicKey,
        lamports: 1,
      }),
    );
    const keys = accountKeysFromLoadedMessage(tx, [])!;
    tx.message.addressTableLookups.push({
      accountKey: Keypair.generate().publicKey,
      writableIndexes: [],
      readonlyIndexes: [],
    });
    const r = inspectSwapInstructions({
      tx,
      accountKeys: keys,
      ourPubkey: payer.publicKey,
      allowlist: allow,
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /lookup tables were not resolved/);
  });

  it("a wallet token account that only appears in the resolved key list cannot be drained", () => {
    const wallet = Keypair.generate().publicKey.toBase58();
    const extraAta = Keypair.generate().publicKey.toBase58();
    const outMint = Keypair.generate().publicKey.toBase58();
    function tok(amount: bigint): string {
      const buf = Buffer.alloc(165, 0);
      buf.writeBigUInt64LE(amount, 64);
      return buf.toString("base64");
    }
    const r = evaluateSimulatedBalances({
      ourWallet: wallet,
      inputMint: WSOL_MINT,
      outputMint: WSOL_MINT,
      expectedInAmount: 1_000_000n,
      otherAmountThreshold: 1n,
      maxExtraLamports: 50_000,
      maxExtraTokenOutflow: 0n,
      pre: {
        lamports: new Map([[wallet, 5_000_000]]),
        tokenAmounts: new Map([[extraAta, 50n]]),
        tokenMints: new Map([[extraAta, outMint]]),
      },
      watchedAddresses: [wallet, extraAta],
      postAccounts: [
        { address: wallet, lamports: 4_000_000, dataBase64: null },
        { address: extraAta, lamports: 0, dataBase64: tok(1n) },
      ],
      inputTokenAccount: null,
      outputTokenAccount: null,
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /unexpected drain/);
  });
});

describe("H1 inUsd cap and SOL price divergence", () => {
  it("rejects a missing or oversized Jupiter inUsdValue", () => {
    assert.equal(jupiterInUsdAllowed(undefined, 5, 200), false);
    assert.equal(jupiterInUsdAllowed(5.1, 5, 200), true);
    assert.equal(jupiterInUsdAllowed(5.2, 5, 200), false);
  });

  it("fails closed when Jupiter and CoinGecko disagree", async () => {
    const ps = new PriceService({
      fetchImpl: (async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("price/v3")) {
          return new Response(
            JSON.stringify({
              So11111111111111111111111111111111111111112: { usdPrice: 100, blockId: 1 },
            }),
            { status: 200 },
          );
        }
        if (url.includes("coingecko")) {
          return new Response(JSON.stringify({ solana: { usd: 150 } }), { status: 200 });
        }
        return new Response("{}", { status: 500 });
      }) as typeof fetch,
    });
    await assert.rejects(() => ps.getSolUsd(), /divergence/);
  });
});

describe("H2 realized PnL accumulates on a full close", () => {
  it("keeps the partial slice when the position closes", () => {
    const dir = path.join(tmp, "pnl");
    fs.rmSync(dir, { recursive: true, force: true });
    const store = new Store(dir);
    store.insertPosition({
      id: "p",
      traderUserId: "uid-1",
      traderHandle: "alpha",
      tradeId: null,
      chain: "solana",
      tokenAddress: MINT,
      tokenSymbol: "T",
      entryUsd: 2,
      sizeUsd: 2,
      remainingUsd: 2,
      quantityRaw: "100",
      entryPriceUsd: null,
      traderSizeAtEntryUsd: null,
      traderTokenAmountAtEntry: null,
      openedAt: new Date().toISOString(),
      sourceEventId: "p",
      status: "open",
      isDryRun: false,
    });
    store.applyPartialClose("p", {
      soldRaw: "50",
      remainingRaw: "50",
      remainingUsd: 1,
      realizedPnlUsd: -0.4,
      fullyClosed: false,
      isDryRun: false,
      exitReason: "partial",
      exitUsd: 0.6,
    });
    store.applyPartialClose("p", {
      soldRaw: "50",
      remainingRaw: "0",
      remainingUsd: 0,
      realizedPnlUsd: 0.1,
      fullyClosed: true,
      isDryRun: false,
      exitReason: "close",
      exitUsd: 1.1,
    });
    const row = store.getPosition("p")!;
    assert.equal(row.status, "closed");
    assert.equal(row.remainingUsd, 0);
    assert.ok(Math.abs((row.realizedPnlUsd ?? 0) - -0.3) < 1e-9);
    const stats = store.traderRealizedStats("uid-1", "alpha", { book: "live" });
    assert.ok(Math.abs(stats.realizedPnlUsd - -0.3) < 1e-9);
    store.close();
  });
});

describe("H3 zero delta, empty book, and a second flat read", () => {
  const pos = {
    id: "p",
    traderUserId: "u1",
    traderHandle: "alpha",
    tradeId: null,
    chain: "solana" as const,
    tokenAddress: MINT,
    tokenSymbol: "T",
    entryUsd: 2,
    sizeUsd: 2,
    remainingUsd: 2,
    quantityRaw: "100",
    entryPriceUsd: null,
    traderSizeAtEntryUsd: 1000,
    traderTokenAmountAtEntry: 1000,
    openedAt: new Date().toISOString(),
    sourceEventId: "e",
    status: "open" as const,
    isDryRun: true,
  };

  it("ignores a sell when the token amount did not fall", async () => {
    const r = await resolveSellFraction({
      pos,
      alert: alertSell("zero-delta", 400),
      fomo: {
        positions: async () => ({
          positions: [{ token: { address: MINT }, status: "open", amount: 1000 }],
        }),
      } as never,
    });
    assert.equal(r.method, "fomo_no_change");
    assert.equal(r.fraction, 0);
  });

  it("treats an empty positions array as unknown and a missing mint as absent", async () => {
    assert.equal(traderHoldState({ positions: [] }, MINT), "unknown");
    const empty = await resolveSellFraction({
      pos,
      fomo: { positions: async () => ({ positions: [] }) } as never,
    });
    assert.equal(empty.method, "unknown");
    const absent = await resolveSellFraction({
      pos,
      fomo: {
        positions: async () => ({
          positions: [{ token: { address: "other" }, status: "open", amount: 1 }],
        }),
      } as never,
    });
    assert.equal(absent.method, "fomo_absent");
    assert.equal(absent.fraction, null);
  });
});

describe("H4 one in-flight sell does not walk the slippage ladder", () => {
  it("stops after an in-flight signature", async () => {
    const dir = path.join(tmp, "inflight");
    fs.rmSync(dir, { recursive: true, force: true });
    const cfg = loadAppConfig(path.join(root, "config.example.yaml"));
    cfg.traderSource = "manual";
    cfg.traders = [{ handle: "alpha", userId: "uid-1", enabled: true, chains: ["solana"] }];
    cfg.sizing.minTraderTradeUsd = 0;
    cfg.risk.cooldownSeconds = 0;
    const env: EnvConfig = {
      fomoApiKey: "",
      dryRun: true,
      solanaRpcUrl: "http://127.0.0.1:1",
      solanaPrivateKey: "",
      jupiterApiKey: "",
      baseRpcUrl: "",
      basePrivateKey: "",
      zeroXApiKey: "",
      telegramBotToken: "",
      telegramChatId: "",
      telegramAllowedUserIds: [],
      configPath: "",
      dataDir: dir,
      killSwitchPath: path.join(dir, "k"),
    };
    const store = new Store(dir);
    const watchlist = new Watchlist(cfg, null, undefined, store);
    await watchlist.start();
    let sells = 0;
    const fake = {
      async buyToken(req: SwapRequest): Promise<SwapResult> {
        return { ok: true, dryRun: true, outAmountRaw: "100", outUsd: req.sellUsd, inUsd: req.sellUsd };
      },
      async sellToken(): Promise<SwapResult> {
        sells++;
        return { ok: false, dryRun: true, inFlight: true, error: "pending" };
      },
    };
    const exec = {
      buy: (_c: string, r: Omit<SwapRequest, "chain">) => fake.buyToken({ ...r, chain: "solana" }),
      sell: (_c: string, r: Omit<SwapRequest, "chain">) => fake.sellToken(),
      forChain: () => fake,
    } as unknown as ExecutionRouter;
    const engine = new CopyEngine(
      env,
      cfg,
      store,
      exec,
      new KillSwitch(env.killSwitchPath),
      new TelegramNotifier("", ""),
      watchlist,
    );
    await engine.handleAlert(alertBuy("b1"));
    const id = store.listOpen({ includeDryRun: true })[0]!.id;
    await engine.handleAlert(alertSell("s1", 1000));
    assert.equal(sells, 1);
    assert.equal(store.getPosition(id)?.status, "closing");
    store.close();
  });
});

function alertBuy(eventId: string): NormalizedAlert {
  return {
    eventId,
    alertType: "buy",
    source: "feed",
    userId: "uid-1",
    tradeId: eventId,
    swapId: null,
    traderHandle: "alpha",
    tokenSymbol: "TOK",
    tokenAddress: MINT,
    chain: "solana",
    chainId: null,
    tradeUsd: 1000,
    usdValue: 1000,
    positionValueUsd: 1000,
    text: null,
    ts: Date.now(),
    txHash: null,
    marketCapUsd: null,
    raw: {},
  };
}

function alertSell(eventId: string, tradeUsd: number): NormalizedAlert {
  return { ...alertBuy(eventId), alertType: "sell", tradeUsd };
}
