/** Paper fill versus a later mark, in basis points. Positive means the mark is above the quote. */
export function slippageDriftBps(quotedUsd: number, markUsd: number): number | null {
  if (!(quotedUsd > 0) || !(markUsd > 0) || !Number.isFinite(quotedUsd) || !Number.isFinite(markUsd)) {
    return null;
  }
  return Math.round(((markUsd - quotedUsd) / quotedUsd) * 10_000);
}
