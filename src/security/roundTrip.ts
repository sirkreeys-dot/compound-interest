/** Loss in bps of a round trip: USD in vs USD received selling the tokens back. */
export function roundTripLossBps(usdIn: number, usdOut: number): number | null {
  if (!(usdIn > 0) || !(usdOut >= 0) || !Number.isFinite(usdIn) || !Number.isFinite(usdOut)) {
    return null;
  }
  return Math.round((1 - usdOut / usdIn) * 10_000);
}

export function roundTripRejection(usdIn: number, usdOut: number | null, maxLossBps: number): string | null {
  if (!(maxLossBps > 0)) return null;
  if (usdOut == null || !Number.isFinite(usdOut)) {
    return "round_trip: sell quote had no USD out (fail closed)";
  }
  const loss = roundTripLossBps(usdIn, usdOut);
  if (loss == null) return "round_trip: could not compute loss (fail closed)";
  if (loss > maxLossBps) {
    return `round_trip: loss ${loss}bps > roundTripMaxLossBps ${maxLossBps} (in=${usdIn} out=${usdOut})`;
  }
  return null;
}
