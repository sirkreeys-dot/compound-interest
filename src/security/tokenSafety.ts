/**
 * Solana token safety: freeze authority + Token-2022 transfer hooks / transfer fees.
 * Uses getParsedAccountInfo — FOMO alerts alone are never enough to trust a mint.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { log } from "../utils/logger.js";

export type TokenSafetyMode = "block" | "warn" | "off";

export interface TokenSafetyFinding {
  mint: string;
  program: "spl-token" | "token-2022" | "unknown";
  freezeAuthority: string | null;
  mintAuthority: string | null;
  hasTransferHook: boolean;
  hasTransferFee: boolean;
  warnings: string[];
  /** True when mode=block and a hard-block condition matched. */
  blocked: boolean;
  blockReason?: string;
}

const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

export async function inspectSolanaMint(
  rpcUrl: string,
  mint: string,
  opts: {
    mode?: TokenSafetyMode;
    blockFreezeAuthority?: boolean;
    blockTransferHooks?: boolean;
    /** Transfer-fee mints: block | warn (default warn). */
    transferFeePolicy?: "block" | "warn" | "off";
    fetchImpl?: typeof fetch;
  } = {},
): Promise<TokenSafetyFinding> {
  const mode = opts.mode ?? "block";
  const blockFreeze = opts.blockFreezeAuthority ?? true;
  const blockHooks = opts.blockTransferHooks ?? true;
  const feePolicy = opts.transferFeePolicy ?? "warn";

  const finding: TokenSafetyFinding = {
    mint,
    program: "unknown",
    freezeAuthority: null,
    mintAuthority: null,
    hasTransferHook: false,
    hasTransferFee: false,
    warnings: [],
    blocked: false,
  };

  if (mode === "off") return finding;

  try {
    const conn = new Connection(rpcUrl, "confirmed");
    const pk = new PublicKey(mint);
    const acc = await conn.getParsedAccountInfo(pk, "confirmed");
    if (!acc.value) {
      finding.warnings.push("mint account not found on RPC");
      finding.blocked = mode === "block";
      finding.blockReason = "mint_not_found";
      return finding;
    }
    const owner = acc.value.owner.toBase58();
    if (owner === TOKEN_PROGRAM) finding.program = "spl-token";
    else if (owner === TOKEN_2022_PROGRAM) finding.program = "token-2022";

    const data = acc.value.data;
    if (data && typeof data === "object" && "parsed" in data) {
      const parsed = data as {
        parsed?: {
          type?: string;
          info?: {
            freezeAuthority?: string | null;
            mintAuthority?: string | null;
            extensions?: Array<{ extension?: string; state?: unknown }>;
          };
        };
      };
      const info = parsed.parsed?.info;
      if (info) {
        finding.freezeAuthority = info.freezeAuthority ?? null;
        finding.mintAuthority = info.mintAuthority ?? null;
        const exts = info.extensions ?? [];
        for (const e of exts) {
          const name = (e.extension ?? "").toLowerCase();
          if (name === "transferhook" || name === "transfer_hook") {
            finding.hasTransferHook = true;
          }
          if (name === "transferfeeconfig" || name === "transfer_fee_config") {
            finding.hasTransferFee = true;
          }
        }
      }
    }

    if (finding.freezeAuthority && blockFreeze) {
      const msg = `freeze authority set: ${finding.freezeAuthority}`;
      finding.warnings.push(msg);
      if (mode === "block") {
        finding.blocked = true;
        finding.blockReason = "freeze_authority";
      }
    }
    if (finding.hasTransferHook && blockHooks) {
      finding.warnings.push("Token-2022 transfer hook present");
      if (mode === "block") {
        finding.blocked = true;
        finding.blockReason = finding.blockReason ?? "transfer_hook";
      }
    }
    if (finding.hasTransferFee) {
      finding.warnings.push("Token-2022 transfer fee config present");
      if (feePolicy === "block" && mode === "block") {
        finding.blocked = true;
        finding.blockReason = finding.blockReason ?? "transfer_fee";
      }
    }
  } catch (e) {
    log.warn(
      `tokenSafety inspect failed for ${mint}: ${e instanceof Error ? e.message : String(e)}`,
    );
    finding.warnings.push("token safety RPC inspect failed");
    // Fail closed on buys when mode=block — cannot verify
    if (mode === "block") {
      finding.blocked = true;
      finding.blockReason = "inspect_failed";
    }
  }

  return finding;
}
