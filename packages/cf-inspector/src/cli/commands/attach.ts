import process from "node:process";

import { fetchInspectorVersion } from "../../inspector.js";
import type { AttachCommandOptions } from "../commandTypes.js";
import { writeJson } from "../output.js";
import { openTarget, resolveTarget } from "../target.js";

export async function handleAttach(opts: AttachCommandOptions): Promise<void> {
  const target = resolveTarget(opts);
  const tunnel = await openTarget(target);
  try {
    const version = await fetchInspectorVersion(tunnel.host, tunnel.port, 5_000);
    if (opts.json) {
      writeJson({ host: tunnel.host, port: tunnel.port, ...version });
      return;
    }
    process.stdout.write(
      `Connected to ${tunnel.host}:${tunnel.port.toString()}\n` +
        `  Browser: ${version.browser}\n` +
        `  Protocol: ${version.protocolVersion}\n`,
    );
  } finally {
    await tunnel.dispose();
  }
}
