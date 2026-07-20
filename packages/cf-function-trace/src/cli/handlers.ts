import type { CliCommandHandlers } from "./program.js";
import {
  runDiffCommand,
  runPurgeCommand,
  runRunsCommand,
  runShowCommand,
  runStateCommand,
  type QueryCommandContext,
} from "./query-commands.js";
import {
  runPlanCommand,
  runRecordCommand,
  type TraceCommandContext,
} from "./trace-commands.js";

export type DefaultHandlerContext = TraceCommandContext;

function queryContext(context: DefaultHandlerContext): QueryCommandContext {
  return {
    stdout: context.stdout,
    ...(context.saptoolsRoot === undefined ? {} : { saptoolsRoot: context.saptoolsRoot }),
  };
}

export function createDefaultHandlers(context: DefaultHandlerContext): CliCommandHandlers {
  return {
    plan: async (file, functionSelector, flags): Promise<void> => {
      await runPlanCommand(file, functionSelector, flags, context);
    },
    record: async (file, functionSelector, flags): Promise<void> => {
      await runRecordCommand(file, functionSelector, flags, context);
    },
    show: async (run, flags): Promise<void> => {
      await runShowCommand(run, flags, queryContext(context));
    },
    state: async (run, flags): Promise<void> => {
      await runStateCommand(run, flags, queryContext(context));
    },
    diff: async (run, flags): Promise<void> => {
      await runDiffCommand(run, flags, queryContext(context));
    },
    runs: async (flags): Promise<void> => {
      await runRunsCommand(flags, queryContext(context));
    },
    purge: async (run): Promise<void> => {
      await runPurgeCommand(run, queryContext(context));
    },
  };
}
