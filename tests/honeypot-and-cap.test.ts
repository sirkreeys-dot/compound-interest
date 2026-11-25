import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadAppConfig } from "../src/config.js";
import {
  enforcedOverheadCap,
  overheadRejection,
  OVERHEAD_HARD_CAP_LAMPORTS,
  sumOverheadLamports,
} from "../src/security/overhead.js";
import { roundTripRejection } from "../src/security/roundTrip.js";
import { sellSimLogLine, sellSimReasonFromRpc, sellSimVerdict, type SellSimReason } from "../src/security/sellSim.js";
import { inspectSolanaMint } from "../src/security/tokenSafety.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const MINT = "6863YfxMrFZhKidtv7oCcfoL2s6hvnfp7cSnBoKMp1dP";
const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

const KNOWN_SYMBOL: Record<string, string> = {
  [BONK.toLowerCase()]: "BONK",
  [BASE_USDC.toLowerCase()]: "USDC",
};

function mismatches(rows: { token?: string; tokenAddress?: string }[]): string[] {
  const out: string[] = [];
  for (const row of rows) {
    if (!row.token || !row.tokenAddress) continue;
    const expected = KNOWN_SYMBOL[row.tokenAddress.toLowerCase()];
    if (expected && row.token.toUpperCase() !== expected) {
      out.push(`${row.token} != ${expected} for ${row.tokenAddress}`);
    }
  }
  return out;
}

function mintInfo(extensions: Array<{ extension: string; state?: unknown }>, freeze: string | null = null) {
  return async () => ({
    owner: TOKEN_2022,
    parsed: {
      parsed: {
        type: "mint",
        info: { mintAuthority: null, freezeAuthority: freeze, supply: "100", extensions },
      },
    },
  });
}

describe("sell simulation outcomes", () => {
  const cases: SellSimReason[] = [
    "honeypot",
    "high_tax",
    "no_route",
    "sim_error",
    "timeout",
    "allowlist",
  ];

  for (const reason of cases) {
    it(`live mode refuses ${reason}`, () => {
      const live = sellSimVerdict(reason, true);
      assert.equal(live.outcome, "failed");
      assert.equal(live.refuseBuy, true);
      const line = sellSimLogLine(reason, true, "fixture");
      assert.match(line, /outcome=failed/);
      assert.doesNotMatch(line, /outcome=passed/);
    });
  }

  it("a skip is not a pass, and live mode still refuses it", () => {
    for (const reason of ["no_public_key", "no_rpc", "no_balance"] as const) {
      const dry = sellSimVerdict(reason, false);
      const live = sellSimVerdict(reason, true);
      assert.equal(dry.outcome, "skipped");
      assert.equal(dry.refuseBuy, false);
      assert.equal(live.outcome, "skipped");
      assert.equal(live.refuseBuy, true);
      assert.match(sellSimLogLine(reason, false, "x"), /outcome=skipped/);
      assert.doesNotMatch(sellSimLogLine(reason, false, "x"), /outcome=passed/);
    }
    const ok = sellSimVerdict("simulated", false);
    assert.equal(ok.outcome, "passed");
    assert.equal(ok.refuseBuy, false);
    assert.match(sellSimLogLine("simulated", true, "buy-then-sell simulation succeeded"), /outcome=passed/);
    assert.doesNotMatch(sellSimLogLine("no_balance", true, "not a pass"), /outcome=passed/);
  });

  it("a null simulation body is a failure, not a pass", () => {
    assert.equal(sellSimReasonFromRpc(null), "sim_error");
    assert.equal(sellSimReasonFromRpc(undefined), "sim_error");
    const line = sellSimLogLine("sim_error", true, "null simulation response");
    assert.match(line, /outcome=failed/);
    assert.equal(sellSimVerdict("sim_error", true).refuseBuy, true);
    assert.equal(sellSimReasonFromRpc({ err: null, logs: [] }), "simulated");
  });
});

describe("honeypot safety fixtures refuse the buy", () => {
  it("extreme sell tax above 25% is rejected", () => {
    const err = roundTripRejection(2, 1.4, 2500);
    assert.match(err ?? "", /round_trip/);
  });

  it("transfer hook, permanent delegate, transfer fee, and freeze authority block", async () => {
    const hook = await inspectSolanaMint("http://127.0.0.1", MINT, {
      mode: "block",
      getParsedAccountInfo: mintInfo([{ extension: "transferHook" }]),
    });
    assert.equal(hook.blocked, true);
    assert.equal(hook.blockReason, "transfer_hook");
    const delegate = await inspectSolanaMint("http://127.0.0.1", MINT, {
      mode: "block",
      getParsedAccountInfo: mintInfo([{ extension: "permanentDelegate" }]),
    });
    assert.equal(delegate.blockReason, "permanent_delegate");
    const fee = await inspectSolanaMint("http://127.0.0.1", MINT, {
      mode: "block",
      maxTransferFeeBps: 100,
      getParsedAccountInfo: mintInfo([
        { extension: "transferFeeConfig", state: { newerTransferFee: { transferFeeBasisPoints: 5000 } } },
      ]),
    });
    assert.equal(fee.blockReason, "transfer_fee");
    const freeze = await inspectSolanaMint("http://127.0.0.1", MINT, {
      mode: "block",
      getParsedAccountInfo: mintInfo([], "FreezeAuthority111"),
    });
    assert.equal(freeze.blockReason, "freeze_authority");
  });
});

describe("overhead cap in integer lamports", () => {
  const cap = 5_000_000n;

  it("exactly the cap passes and one lamport over blocks", () => {
    assert.equal(overheadRejection(cap, cap), null);
    assert.match(overheadRejection(cap + 1n, cap) ?? "", /5000001/);
    const at = sumOverheadLamports({
      rentFeeLamports: 2_039_280,
      signatureFeeLamports: 5_000,
      prioritizationFeeLamports: 2_955_720,
    });
    assert.equal(at.ok && at.total, cap);
    const over = sumOverheadLamports({
      rentFeeLamports: 2_039_280,
      signatureFeeLamports: 5_000,
      prioritizationFeeLamports: 2_955_721,
    });
    assert.equal(over.ok && overheadRejection(over.total, cap) !== null, true);
  });

  it("rejects non-integers and missing fields, and clamps config to the hard cap", () => {
    assert.equal(sumOverheadLamports({ rentFeeLamports: 1.5 }).ok, false);
    assert.equal(sumOverheadLamports({}).ok, false);
    assert.equal(enforcedOverheadCap(0), 5_000_000n);
    assert.equal(enforcedOverheadCap(Number(OVERHEAD_HARD_CAP_LAMPORTS) + 1), OVERHEAD_HARD_CAP_LAMPORTS);
    assert.equal(enforcedOverheadCap(5_000_000), 5_000_000n);
  });

  it("config cannot set the cap to 0 or above 0.01 SOL", () => {
    const yaml = fs.readFileSync(path.join(root, "config.example.yaml"), "utf8");
    const dir = path.join(root, "data", "test-cap");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "zero.yaml"), yaml.replace("simMaxOverheadLamports: 5000000", "simMaxOverheadLamports: 0"));
    fs.writeFileSync(
      path.join(dir, "huge.yaml"),
      yaml.replace("simMaxOverheadLamports: 5000000", "simMaxOverheadLamports: 50000000"),
    );
    assert.throws(() => loadAppConfig(path.join(dir, "zero.yaml")));
    assert.throws(() => loadAppConfig(path.join(dir, "huge.yaml")));
  });
});

describe("fixture symbol matches mint", () => {
  it("sample alerts use BONK for the BONK mint and USDC for Base USDC", () => {
    const rows = JSON.parse(fs.readFileSync(path.join(root, "fixtures/sample-alerts.json"), "utf8")) as {
      token?: string;
      tokenAddress?: string;
    }[];
    assert.deepEqual(mismatches(rows), []);
    assert.deepEqual(mismatches([{ token: "PONS", tokenAddress: BONK }]), [
      `PONS != BONK for ${BONK}`,
    ]);
  });
});
