import { randomBytes } from "node:crypto";

const SENTINEL_PREFIX = "__CFI_LOG_";
const SENTINEL_SUFFIX = "__";

export function buildLogpointCondition(sentinel: string, expression: string): string {
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

export function generateSentinel(): string {
  return `${SENTINEL_PREFIX}${randomBytes(8).toString("hex")}${SENTINEL_SUFFIX}`;
}

export { SENTINEL_PREFIX };
