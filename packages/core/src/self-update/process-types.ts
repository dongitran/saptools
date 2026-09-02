import type { ChildProcess, SpawnOptions } from "node:child_process";

/** The subset of `child_process.spawn` the self-updater relies on, so tests can inject a fake. */
export type SpawnLike = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
