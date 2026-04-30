import type { ExplorerErrorCode } from "./types.js";

export class CfExplorerError extends Error {
  public readonly code: ExplorerErrorCode;
  public readonly detail?: string;

  public constructor(code: ExplorerErrorCode, message: string, detail?: string) {
    super(message);
    this.name = "CfExplorerError";
    this.code = code;
    if (detail !== undefined) {
      this.detail = detail;
    }
  }
}

export function toExplorerError(error: unknown): CfExplorerError {
  if (error instanceof CfExplorerError) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  return new CfExplorerError("REMOTE_COMMAND_FAILED", message);
}
