export const GITPORT_ERROR_CODE = {
  MissingToken: "MISSING_TOKEN",
  InvalidInput: "INVALID_INPUT",
  GitFailed: "GIT_FAILED",
  GitLabFailed: "GITLAB_FAILED",
  MetadataFailed: "METADATA_FAILED",
} as const;

export type GitportErrorCode = (typeof GITPORT_ERROR_CODE)[keyof typeof GITPORT_ERROR_CODE];

export class GitportError extends Error {
  public readonly code: GitportErrorCode;

  public constructor(code: GitportErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GitportError";
    this.code = code;
  }
}
