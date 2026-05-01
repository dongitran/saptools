import { buildLogpointCondition, generateSentinel, SENTINEL_PREFIX } from "./condition.js";
import { parseLogEvent } from "./events.js";

export { buildLogpointCondition } from "./condition.js";
export { streamLogpoint } from "./stream.js";
export type { LogpointEvent } from "./events.js";
export type { LogpointStreamOptions, LogpointStreamResult } from "./stream.js";

export const internalsForTesting = {
  buildLogpointCondition,
  parseLogEvent,
  generateSentinel,
  SENTINEL_PREFIX,
};
