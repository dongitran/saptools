function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function parsed(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

export function hasSingleHopHelperReturn(value: unknown): boolean {
  const chain = typeof value === 'string' ? parsed(value) : value;
  return Array.isArray(chain) && chain.some((step) =>
    record(step) && step.bindingOrigin === 'single_hop_helper_return');
}
