import { connectInspector } from "@saptools/cf-inspector";
import type { InspectorSession } from "@saptools/cf-inspector";

import type { InspectorRuntimeClient } from "./types.js";

interface RuntimeEvaluateResult {
  readonly result?: { readonly value?: unknown };
  readonly exceptionDetails?: unknown;
}

export async function connectRuntimeInspector(localPort: number): Promise<InspectorRuntimeClient> {
  const session = await connectInspector({ port: localPort, host: "127.0.0.1" });
  return new CdpRuntimeClient(session);
}

class CdpRuntimeClient implements InspectorRuntimeClient {
  public constructor(private readonly session: InspectorSession) {}

  public async evaluate(expression: string, timeoutMs: number): Promise<unknown> {
    const result = await raceEvaluate(
      this.session.client.send<RuntimeEvaluateResult>("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
        silent: true,
      }),
      timeoutMs,
    );
    return extractEvaluateValue(result);
  }

  public async close(): Promise<void> {
    await this.session.dispose();
  }
}

async function raceEvaluate(promise: Promise<RuntimeEvaluateResult>, timeoutMs: number): Promise<RuntimeEvaluateResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error("Runtime.evaluate timed out."));
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    promise.catch(() => {
      return;
    });
  }
}

function extractEvaluateValue(result: RuntimeEvaluateResult): unknown {
  if (result.exceptionDetails !== undefined) {
    throw new Error("Runtime.evaluate failed.");
  }
  return result.result?.value;
}
