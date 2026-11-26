/**
 * Local-validator trap proof. Uses a throwaway keypair created in this VM.
 * Never prints the key. Simulation uses sigVerify:false. Live sends only to
 * 127.0.0.1 when SOLANA_ALLOW_LOOPBACK=true.
 *
 * Requires solana-test-validator, spl-token, and a keypair at THROWAY_KEY
 * (default /tmp/throwaway.json). Optional hook .so at HOOK_SO.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import {
  Connection,
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { loadAppConfig, type EnvConfig } from "../src/config.js";
import { ExecutionRouter } from "../src/execution/index.js";
import type { JupiterOrder, RouteProvider } from "../src/execution/solana.js";
import { TelegramNotifier } from "../src/notify/telegram.js";
import { sellSimLogLine, sellSimReasonFromRpc, sellSimVerdict } from "../src/security/sellSim.js";
import { inspectSolanaMint } from "../src/security/tokenSafety.js";
import { Store } from "../src/store/db.js";
import { reconcilePendingSwaps } from "../src/store/reconcilePending.js";
import path from "node:path";

const RPC = process.env.SOLANA_RPC_URL ?? "http://127.0.0.1:8899";
const KEY_PATH = process.env.THROWAY_KEY ?? "/tmp/throwaway.json";
const BIN = process.env.SOLANA_BIN ?? `${process.env.HOME}/.local/share/solana/install/active_release/bin`;
const WSOL = "So11111111111111111111111111111111111111112";

function cli(bin: string, args: string[]): string {
  return execFileSync(path.join(BIN, bin), args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    env: { ...process.env, PATH: `${BIN}:${process.env.PATH ?? ""}` },
  });
}

function createToken(args: string[]): string {
  const out = cli("spl-token", [
    "-C",
    "/tmp/solana-cli.yml",
    "--output",
    "json",
    "create-token",
    ...args,
  ]);
  const parsed = JSON.parse(out) as { commandOutput?: { address?: string }; address?: string };
  const address = parsed.commandOutput?.address ?? parsed.address;
  if (!address) throw new Error("create-token did not return an address");
  return address;
}

async function spl(): Promise<{
  getOrCreateAssociatedTokenAccount: Function;
  mintTo: Function;
  freezeAccount: Function;
  createTransferCheckedInstruction: Function;
  createCloseAccountInstruction: Function;
  TOKEN_2022_PROGRAM_ID: PublicKey;
}> {
  const root = process.env.SPL_TOKEN_ROOT ?? "/tmp/spl/node_modules/@solana/spl-token/lib/esm/index.js";
  return import(root);
}

function logLine(kind: string, mint: string, reason: string, detail: string): void {
  const verdict = sellSimVerdict(reason as "honeypot", true);
  const line = sellSimLogLine(reason as "honeypot", true, detail);
  console.log(`${kind} mint=${mint} ${line} refuseBuy=${verdict.refuseBuy}`);
}

async function main(): Promise<void> {
  if (!fs.existsSync(KEY_PATH)) throw new Error(`missing throwaway key file ${KEY_PATH}`);
  process.env.DRY_RUN = "false";
  cli("solana", ["config", "set", "--url", RPC, "--keypair", KEY_PATH, "-C", "/tmp/solana-cli.yml"]);
  const secret = Uint8Array.from(JSON.parse(fs.readFileSync(KEY_PATH, "utf8")) as number[]);
  const payer = Keypair.fromSecretKey(secret);
  const conn = new Connection(RPC, "confirmed");
  const token = await spl();
  console.log(`validator ok payer=${payer.publicKey.toBase58()}`);

  let hookProgram = process.env.HOOK_PROGRAM?.trim() ?? "";
  const so = process.env.HOOK_SO ?? "/tmp/reject-hook/target/deploy/reject_hook.so";
  if (!hookProgram && fs.existsSync(so)) {
    const deployed = cli("solana", ["program", "deploy", so, "-C", "/tmp/solana-cli.yml"]);
    const match = deployed.match(/Program Id: (\w+)/);
    hookProgram = match?.[1] ?? "";
    console.log(hookProgram ? "deployed reject hook" : "hook deploy output had no program id");
  }
  if (!hookProgram) {
    hookProgram = Keypair.generate().publicKey.toBase58();
    console.log("no compiled hook program; using an undeployed program id so transfers fail closed");
  }

  const feeMint = createToken([
    "--program-2022",
    "--decimals",
    "6",
    "--transfer-fee-basis-points",
    "5000",
    "--transfer-fee-maximum-fee",
    "1000000",
  ]);
  const delegateMint = createToken(["--program-2022", "--decimals", "6", "--enable-permanent-delegate"]);
  const hookMint = createToken(["--program-2022", "--decimals", "6", "--transfer-hook", hookProgram]);
  const freezeMint = createToken(["--decimals", "6", "--enable-freeze"]);
  const emptyMint = createToken(["--decimals", "6"]);
  console.log("mints created");

  const policy = {
    mode: "block" as const,
    blockFreezeAuthority: true,
    blockTransferHooks: true,
    blockMintAuthority: true,
    maxTransferFeeBps: 100,
  };
  for (const [name, mint] of [
    ["transfer_fee_50pct", feeMint],
    ["permanent_delegate", delegateMint],
    ["transfer_hook", hookMint],
    ["freeze_authority", freezeMint],
    ["no_liquidity", emptyMint],
  ] as const) {
    const finding = await inspectSolanaMint(RPC, mint, policy);
    console.log(
      `token_safety name=${name} mint=${mint} blocked=${finding.blocked} reason=${finding.blockReason ?? "none"}`,
    );
    if (!finding.blocked) throw new Error(`${name} was not blocked`);
  }

  const ata = await token.getOrCreateAssociatedTokenAccount(conn, payer, new PublicKey(freezeMint), payer.publicKey);
  await token.mintTo(conn, payer, new PublicKey(freezeMint), ata.address, payer, 1_000_000n);
  await token.freezeAccount(conn, payer, ata.address, new PublicKey(freezeMint), payer);
  const dest = Keypair.generate();
  const destAta = await token.getOrCreateAssociatedTokenAccount(
    conn,
    payer,
    new PublicKey(freezeMint),
    dest.publicKey,
  );
  const transfer = token.createTransferCheckedInstruction(
    ata.address,
    new PublicKey(freezeMint),
    destAta.address,
    payer.publicKey,
    1n,
    6,
  );
  const { blockhash } = await conn.getLatestBlockhash();
  const frozenTx = new VersionedTransaction(
    new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: blockhash,
      instructions: [transfer],
    }).compileToV0Message(),
  );
  const sim = await conn.simulateTransaction(frozenTx, { sigVerify: false, replaceRecentBlockhash: true });
  const reason = sellSimReasonFromRpc(sim.value);
  logLine("frozen_transfer", freezeMint, reason, JSON.stringify(sim.value.err));
  if (reason === "simulated") throw new Error("frozen transfer was classified as a pass");

  for (const [name, mint] of [
    ["fee", feeMint],
    ["hook", hookMint],
    ["delegate", delegateMint],
  ] as const) {
    const source = await token.getOrCreateAssociatedTokenAccount(
      conn,
      payer,
      new PublicKey(mint),
      payer.publicKey,
      false,
      "confirmed",
      undefined,
      token.TOKEN_2022_PROGRAM_ID,
    );
    await token.mintTo(
      conn,
      payer,
      new PublicKey(mint),
      source.address,
      payer,
      1_000_000n,
      [],
      undefined,
      token.TOKEN_2022_PROGRAM_ID,
    );
    const other = Keypair.generate();
    const otherAta = await token.getOrCreateAssociatedTokenAccount(
      conn,
      payer,
      new PublicKey(mint),
      other.publicKey,
      false,
      "confirmed",
      undefined,
      token.TOKEN_2022_PROGRAM_ID,
    );
    const ix = token.createTransferCheckedInstruction(
      source.address,
      new PublicKey(mint),
      otherAta.address,
      payer.publicKey,
      1000n,
      6,
      [],
      token.TOKEN_2022_PROGRAM_ID,
    );
    const latest = await conn.getLatestBlockhash();
    const tx = new VersionedTransaction(
      new TransactionMessage({
        payerKey: payer.publicKey,
        recentBlockhash: latest.blockhash,
        instructions: [ix],
      }).compileToV0Message(),
    );
    const result = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
    const simReason = sellSimReasonFromRpc(result.value);
    if (simReason === "simulated") {
      console.log(
        `${name} mint=${mint} raw_simulate err=null token_safety=blocked decision=refused (not a sell_sim pass)`,
      );
    } else {
      logLine(name, mint, simReason, JSON.stringify(result.value.err));
    }
  }
  logLine("no_liquidity", emptyMint, "no_route", "no pool and no sell route on the local validator");

  const closeMint = createToken(["--decimals", "6"]);
  const closeAta = await token.getOrCreateAssociatedTokenAccount(
    conn,
    payer,
    new PublicKey(closeMint),
    payer.publicKey,
  );
  const latest = await conn.getLatestBlockhash();
  const closeIx = token.createCloseAccountInstruction(closeAta.address, payer.publicKey, payer.publicKey);
  const closeTx = new VersionedTransaction(
    new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: latest.blockhash,
      instructions: [closeIx],
    }).compileToV0Message(),
  );
  const raw = Buffer.from(closeTx.serialize()).toString("base64");
  let signs = 0;
  const originalSign = VersionedTransaction.prototype.sign;
  VersionedTransaction.prototype.sign = function (this: VersionedTransaction, ...args) {
    signs++;
    return originalSign.apply(this, args as never);
  };

  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  const cfg = loadAppConfig(path.join(root, "config.example.yaml"));
  const dir = path.join(root, "data", "local-validator");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const env: EnvConfig = {
    fomoApiKey: "",
    dryRun: false,
    solanaRpcUrl: RPC,
    solanaAllowLoopback: true,
    solanaPrivateKey: JSON.stringify(Array.from(secret)),
    jupiterApiKey: "",
    baseRpcUrl: "",
    basePrivateKey: "",
    zeroXApiKey: "",
    telegramBotToken: "",
    telegramChatId: "",
    telegramAllowedUserIds: [],
    configPath: "",
    dataDir: dir,
    killSwitchPath: path.join(dir, "kill.switch"),
  };
  const store = new Store(dir);
  const exec = new ExecutionRouter(env, cfg, undefined, store);
  const provider: RouteProvider = {
    async order(quote) {
      if (quote.inputMint === freezeMint) {
        return { ok: false, error: "no_route" };
      }
      const order: JupiterOrder = {
        inputMint: quote.inputMint,
        outputMint: quote.outputMint,
        inAmount: quote.amount,
        outAmount: "1000",
        otherAmountThreshold: "1000",
        slippageBps: quote.slippageBps,
        transaction: raw,
        requestId: "local",
        signatureFeeLamports: 5000,
        prioritizationFeeLamports: 0,
        rentFeeLamports: 0,
        inUsdValue: 1,
        outUsdValue: 1,
        taker: quote.taker,
      };
      return { ok: true, order };
    },
  };
  exec.solana!.setRouteProvider(provider);

  const trapBuy = await exec.buy("solana", {
    sellToken: WSOL,
    buyToken: freezeMint,
    sellUsd: 1,
    sellAmountRaw: "1000",
    slippageBps: 300,
    dryRun: false,
  });
  console.log(`live_buy_trap ok=${trapBuy.ok} error=${trapBuy.error ?? ""} signs_so_far=${signs}`);
  if (trapBuy.ok) throw new Error("trap buy was accepted");

  const liveSell = await exec.sell("solana", {
    sellToken: closeMint,
    buyToken: WSOL,
    sellUsd: 1,
    sellAmountRaw: "1",
    slippageBps: 300,
    dryRun: false,
  });
  console.log(`live_sell ok=${liveSell.ok} tx=${liveSell.txHash ?? ""} error=${liveSell.error ?? ""} signs=${signs}`);
  if (!liveSell.ok || !liveSell.txHash) throw new Error(`live sell did not land: ${liveSell.error}`);

  const deadHash = Keypair.generate().publicKey.toBase58();
  store.insertPendingSwap({
    id: "expired-row",
    chain: "solana",
    side: "sell",
    tokenAddress: closeMint,
    sizeUsd: 1,
  });
  store.updatePendingSwap("expired-row", {
    status: "broadcast",
    txSignature: Keypair.generate().publicKey.toBase58(),
    blockhash: deadHash,
  });
  const failedSig = await sendFailingTransfer(conn, payer);
  store.insertPendingSwap({
    id: "failed-row",
    chain: "solana",
    side: "sell",
    tokenAddress: closeMint,
    sizeUsd: 1,
  });
  store.updatePendingSwap("failed-row", {
    status: "broadcast",
    txSignature: failedSig,
    blockhash: latest.blockhash,
  });
  store.insertPendingSwap({
    id: "confirmed-row",
    chain: "solana",
    side: "sell",
    tokenAddress: closeMint,
    sizeUsd: 1,
  });
  store.updatePendingSwap("confirmed-row", {
    status: "broadcast",
    txSignature: liveSell.txHash,
    blockhash: latest.blockhash,
  });
  const tg = new TelegramNotifier("", "");
  const reconciled = await reconcilePendingSwaps({
    store,
    env,
    cfg,
    tg,
    rpcUrl: RPC,
    allowLoopback: true,
    connection: conn,
    getWalletTokenAmount: async () => "0",
  });
  for (const id of ["expired-row", "failed-row", "confirmed-row"]) {
    const row = store.getPendingSwap(id);
    console.log(`reconcile id=${id} status=${row?.status ?? "missing"} error=${row?.error ?? ""}`);
  }
  console.log(`reconcile resolved=${reconciled.resolved} unresolved=${reconciled.unresolved} signs=${signs}`);
  VersionedTransaction.prototype.sign = originalSign;
  store.close();
}

async function sendFailingTransfer(conn: Connection, payer: Keypair): Promise<string> {
  const { SystemProgram, Transaction } = await import("@solana/web3.js");
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: payer.publicKey,
      lamports: 1_000_000_000_000,
    }),
  );
  tx.feePayer = payer.publicKey;
  const latest = await conn.getLatestBlockhash();
  tx.recentBlockhash = latest.blockhash;
  tx.sign(payer);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 0 });
  await conn.confirmTransaction(
    { signature: sig, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight },
    "confirmed",
  );
  return sig;
}

main().catch((e) => {
  const msg = e instanceof Error ? e.message : "local validator harness failed";
  console.error(msg.split("\n")[0]?.slice(0, 300) ?? "local validator harness failed");
  process.exit(1);
});
