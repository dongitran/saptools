import { envName, readEnv } from "../config.js";
import { CfHanaError } from "../errors.js";

import { createFakeDriver } from "./fake.js";
import { createHdbDriver } from "./hdb.js";
import type { HanaDriver } from "./types.js";

export type {
  DriverConnectParams,
  DriverConnection,
  DriverExecResult,
  HanaDriver,
} from "./types.js";

/**
 * Create a HANA driver by name. Defaults to `hdb`; the `CF_HANA_DRIVER`
 * environment variable overrides the default when no name is passed.
 */
export function createDriver(name?: string): HanaDriver {
  const resolved = name ?? readEnv(envName("DRIVER")) ?? "hdb";
  switch (resolved) {
    case "hdb":
      return createHdbDriver();
    case "fake":
      return createFakeDriver();
    default:
      throw new CfHanaError("CONFIG", `Unknown HANA driver: ${resolved}`);
  }
}
