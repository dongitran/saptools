export const GITPORT_GITLAB_TOKEN_ENV = "GITPORT_GITLAB_TOKEN";
export const GITPORT_GITLAB_API_BASE_ENV = "GITPORT_GITLAB_API_BASE";

export type CommitPortStatus = "applied" | "skipped" | "incoming-resolved";
export type RunStatus = "running" | "completed";

export interface SourceCommit {
  readonly sha: string;
  readonly title: string;
  readonly message: string;
}

export interface GitLabMergeRequestInfo {
  readonly iid: number;
  readonly title: string;
  readonly sourceBranch: string;
  readonly webUrl: string;
}

export interface GitLabCurrentUser {
  readonly id: number;
  readonly username: string;
}

export interface CreatedMergeRequest {
  readonly iid: number;
  readonly webUrl: string;
  readonly draft: boolean;
}

export interface CommitPortResult {
  readonly sha: string;
  readonly title: string;
  readonly status: CommitPortStatus;
}

export interface ConflictFileReport {
  readonly path: string;
  readonly oursExcerpt: string;
  readonly theirsExcerpt: string;
}

export interface ConflictReport {
  readonly commitSha: string;
  readonly commitTitle: string;
  readonly files: readonly ConflictFileReport[];
}

export interface PortGitLabMergeRequestOptions {
  readonly sourceRepo: string;
  readonly destRepo: string;
  readonly sourceMergeRequestIid: number;
  readonly baseBranch: string;
  readonly portBranch: string;
  readonly title: string;
  readonly token?: string | undefined;
  readonly gitlabApiBase?: string | undefined;
  readonly keepWorkdir?: boolean | undefined;
  readonly yes?: boolean | undefined;
  readonly runId?: string | undefined;
  readonly workRoot?: string | undefined;
  readonly fetchFn?: typeof fetch | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
}

export interface PortGitLabMergeRequestResult {
  readonly runId: string;
  readonly runDir: string;
  readonly destDir: string;
  readonly mergeRequestUrl: string;
  readonly mergeRequestIid: number;
  readonly commits: readonly CommitPortResult[];
  readonly conflicts: readonly ConflictReport[];
}

export interface RunMetadata {
  readonly runId: string;
  readonly runDir: string;
  readonly destDir: string;
  readonly status: RunStatus;
  readonly sourceRepo: string;
  readonly destRepo: string;
  readonly sourceMergeRequestIid: number;
  readonly baseBranch: string;
  readonly portBranch: string;
  readonly mergeRequestUrl?: string | undefined;
  readonly mergeRequestIid?: number | undefined;
}
