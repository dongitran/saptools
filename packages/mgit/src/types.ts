export type BranchStatus = "in_sync" | "ahead" | "behind" | "diverged" | "no_remote";

export interface Repo {
  readonly name: string;
  readonly path: string;
}

export interface ReposConfig {
  readonly repos: Record<string, string>;
}

export interface GroupsConfig {
  readonly groups: Record<string, readonly string[]>;
}

export interface ContextConfig {
  readonly context: string | null;
}

export interface GitStatusInfo {
  readonly branch: string;
  readonly branchStatus: BranchStatus;
  readonly staged: boolean;
  readonly unstaged: boolean;
  readonly untracked: boolean;
  readonly stashed: boolean;
  readonly ahead: number;
  readonly behind: number;
}

export interface RepoStatus {
  readonly name: string;
  readonly path: string;
  readonly status: GitStatusInfo | null;
  readonly error: string | null;
}

export interface CommandResult {
  readonly name: string;
  readonly output: string;
  readonly error: string | null;
}
