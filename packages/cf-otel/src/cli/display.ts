/** Signed: a negative input (e.g. an overlapping-child gap from `gaps`) keeps its sign rather than formatting via its raw negative nanosecond count. */
export function formatDurationNanos(nanos: number): string {
  const sign = nanos < 0 ? "-" : "";
  const abs = Math.abs(nanos);
  if (abs < 1_000) {
    return `${sign}${String(abs)}ns`;
  }
  if (abs < 1_000_000) {
    return `${sign}${(abs / 1_000).toFixed(1)}µs`;
  }
  if (abs < 1_000_000_000) {
    return `${sign}${(abs / 1_000_000).toFixed(3)}ms`;
  }
  return `${sign}${(abs / 1_000_000_000).toFixed(3)}s`;
}

export function formatPercent(value: number | undefined): string {
  return value === undefined ? "" : `${value.toFixed(2)}%`;
}

export function formatSignedDuration(deltaNanos: number): string {
  const sign = deltaNanos > 0 ? "+" : deltaNanos < 0 ? "-" : "";
  return `${sign}${formatDurationNanos(Math.abs(deltaNanos))}`;
}

export function formatSignedPercent(before: number, after: number): string {
  if (before === 0) {
    return "";
  }
  const pct = ((after - before) / before) * 100;
  return `${pct > 0 ? "+" : ""}${pct.toFixed(1)}%`;
}
