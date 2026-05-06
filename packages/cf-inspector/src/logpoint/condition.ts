import { randomBytes } from "node:crypto";

const SENTINEL_PREFIX = "__CFI_LOG_";
const SENTINEL_SUFFIX = "__";

export interface LogpointConditionOptions {
  readonly predicate?: string;
  readonly hitCount?: number;
  readonly counterKey?: string;
}

const HITS_GLOBAL = "globalThis.__CFI_LOG_HITS";

function buildLoggingIife(sentinel: string, expression: string): string {
  return [
    "(function(){",
    `var s=${JSON.stringify(sentinel)};`,
    "try{",
    `var v=(${expression});`,
    "var r=typeof v==='string'?v:JSON.stringify(v);",
    "console.log(s, r);",
    "}catch(e){",
    "console.log(s, '!err:'+(e&&e.message?e.message:String(e)));",
    "}",
    "return false;",
    "})()",
  ].join("");
}

function buildHitGate(hitCount: number, counterKey: string): string {
  const keyLiteral = JSON.stringify(counterKey);
  return [
    "(function(){",
    `var m=(${HITS_GLOBAL}=${HITS_GLOBAL}||{});`,
    `var k=${keyLiteral};`,
    "m[k]=(m[k]||0)+1;",
    `return m[k]>=${hitCount.toString()};`,
    "})()",
  ].join("");
}

function combineGuards(guards: readonly string[]): string | undefined {
  const filtered = guards.filter((guard) => guard.length > 0);
  if (filtered.length === 0) {
    return undefined;
  }
  if (filtered.length === 1) {
    return filtered[0];
  }
  return filtered.map((guard) => `(${guard})`).join("&&");
}

export function buildLogpointCondition(
  sentinel: string,
  expression: string,
  options: LogpointConditionOptions = {},
): string {
  const guards: string[] = [];
  if (options.hitCount !== undefined) {
    const counterKey = options.counterKey ?? sentinel;
    guards.push(buildHitGate(options.hitCount, counterKey));
  }
  const userPredicate = options.predicate?.trim();
  if (userPredicate !== undefined && userPredicate.length > 0) {
    guards.push(`(${userPredicate})`);
  }
  const iife = buildLoggingIife(sentinel, expression);
  const guard = combineGuards(guards);
  if (guard === undefined) {
    return iife;
  }
  return `(${guard})?${iife}:false`;
}

export function generateSentinel(): string {
  return `${SENTINEL_PREFIX}${randomBytes(8).toString("hex")}${SENTINEL_SUFFIX}`;
}

export { SENTINEL_PREFIX };
