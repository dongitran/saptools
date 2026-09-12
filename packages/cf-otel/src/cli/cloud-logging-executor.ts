import type { CloudLoggingCfExecutor } from "@saptools/core";

import {
  AMBIENT_CF_CONTEXT,
  cfApi,
  cfAuth,
  cfCurl,
  cfServiceGuid,
  cfSpaceGuid,
  cfTargetSpace,
  getApiEndpointForRegion,
  isCfAuthFailure,
  readCurrentCfTarget,
  withCfSession,
} from "../cf.js";

/**
 * The one adapter between cf-otel's own `cf.ts` and the shared
 * `packages/core` cloud-logging modules.
 *
 * The per-property casts below are required, not stylistic: `cf.ts`'s own
 * `CfExecContext` (keyed on `cfHome`) and `@saptools/core`'s (keyed on
 * `command`, a field no cloud-logging module actually reads — it exists only
 * so each consumer's differently-shaped context can pass through opaquely)
 * share no property name, so TypeScript's "weak type" detection refuses the
 * structural match even though every function below only ever threads `ctx`
 * through untouched. Confirmed via `tsc --noEmit` against every real
 * signature in `cf.ts`: path/name/string arguments and `Promise<string|void>`
 * returns all already match — only the `ctx` parameter's type name differs.
 * `isCfAuthFailure`, `readCurrentCfTarget`, and `getApiEndpointForRegion` need
 * no cast; none of them mention `CfExecContext`.
 */
export const cloudLoggingExecutor: CloudLoggingCfExecutor = {
  ambientContext: AMBIENT_CF_CONTEXT as unknown as CloudLoggingCfExecutor["ambientContext"],
  cfCurl: cfCurl as unknown as CloudLoggingCfExecutor["cfCurl"],
  cfServiceGuid: cfServiceGuid as unknown as CloudLoggingCfExecutor["cfServiceGuid"],
  cfSpaceGuid: cfSpaceGuid as unknown as CloudLoggingCfExecutor["cfSpaceGuid"],
  isCfAuthFailure,
  withCfSession: withCfSession as unknown as CloudLoggingCfExecutor["withCfSession"],
  cfApi: cfApi as unknown as CloudLoggingCfExecutor["cfApi"],
  cfAuth: cfAuth as unknown as CloudLoggingCfExecutor["cfAuth"],
  cfTargetSpace: cfTargetSpace as unknown as CloudLoggingCfExecutor["cfTargetSpace"],
  readCurrentCfTarget,
  getApiEndpointForRegion,
};
