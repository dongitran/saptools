export interface GitLabApiProject {
  id: number;
  name: string;
  path: string;
  path_with_namespace: string;
  http_url_to_repo: string;
  ssh_url_to_repo: string;
  visibility: string;
  archived: boolean;
  namespace: {
    id: number;
    name: string;
    path: string;
    full_path: string;
    kind: string;
  };
}

export interface GitLabApiGroup {
  id: number;
  name: string;
  path: string;
  full_path: string;
  description: string;
  visibility: string;
}

export interface GitLabProject {
  id: number;
  name: string;
  path: string;
  pathWithNamespace: string;
  httpUrlToRepo: string;
  sshUrlToRepo: string;
  visibility: string;
  archived: boolean;
}

export interface GitLabGroup {
  id: number;
  name: string;
  path: string;
  fullPath: string;
  description: string;
  visibility: string;
}

export interface GroupTree {
  group: GitLabGroup;
  projects: GitLabProject[];
  subgroups: GroupTree[];
}

export type CloneProtocol = "https" | "ssh";

export type CloneStatus = "cloned" | "updated" | "skipped" | "failed";

export interface GitLabClientOptions {
  gitlabUrl: string;
  token: string;
}

export interface CloneOptions {
  destination: string;
  gitlabUrl: string;
  token: string;
  concurrency: number;
  protocol: CloneProtocol;
  includeArchived: boolean;
  update: boolean;
  dryRun: boolean;
}

export interface CloneResult {
  project: GitLabProject;
  localPath: string;
  status: CloneStatus;
  error?: string;
}

export interface CloneSummary {
  total: number;
  cloned: number;
  updated: number;
  skipped: number;
  failed: number;
  results: CloneResult[];
}
