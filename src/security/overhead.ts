/**
 * Quoted rent + signature + priority fee, in integer lamports.
 * The configured cap cannot disable the check or rise above OVERHEAD_HARD_CAP_LAMPORTS.
 */
export const OVERHEAD_DEFAULT_LAMPORTS = 5_000_000n;
/** 0.01 SOL. Config and env cannot raise the overhead cap past this. */
export const OVERHEAD_HARD_CAP_LAMPORTS = 10_000_000n;

function asLamports(n: number | null | undefined): bigint | null {
  if (n == null) return null;
  if (!Number.isSafeInteger(n) || n < 0) return null;
  return BigInt(n);
}

/** Ceiling that will actually be enforced. Non-integers and values above the hard cap clamp down. */
export function enforcedOverheadCap(configured: number | null | undefined): bigint {
  const n = asLamports(configured ?? undefined);
  if (n == null || n < 1n) return OVERHEAD_DEFAULT_LAMPORTS;
  return n > OVERHEAD_HARD_CAP_LAMPORTS ? OVERHEAD_HARD_CAP_LAMPORTS : n;
}

export function sumOverheadLamports(parts: {
  rentFeeLamports?: number | null;
  signatureFeeLamports?: number | null;
  prioritizationFeeLamports?: number | null;
}): { ok: true; total: bigint } | { ok: false; error: string } {
  const fields = [
    ["rent", parts.rentFeeLamports],
    ["signature", parts.signatureFeeLamports],
    ["priority", parts.prioritizationFeeLamports],
  ] as const;
  let any = false;
  let total = 0n;
  for (const [name, value] of fields) {
    if (value == null) continue;
    any = true;
    if (!Number.isSafeInteger(value) || value < 0) {
      return { ok: false, error: `overhead: ${name} fee is not a non-negative integer lamport amount` };
    }
    total += BigInt(value);
  }
  if (!any) return { ok: false, error: "overhead: Jupiter omitted rent and fee lamports (fail closed)" };
  return { ok: true, total };
}

/** Exactly `cap` is allowed. `cap + 1` is not. */
export function overheadRejection(total: bigint, cap: bigint): string | null {
  if (total > cap) {
    return `overhead: quoted rent+fees ${total} lamports > cap ${cap}`;
  }
  return null;
}
