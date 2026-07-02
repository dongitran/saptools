export interface JiraTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresIn: number;
  readonly scope: string;
  readonly tokenType: string;
  readonly cloudId: string;
  readonly cloudName: string;
  readonly issuedAt: number;
}

export interface JiraConnectionStatus {
  readonly connected: boolean;
  readonly cloudId: string | null;
  readonly cloudName: string | null;
  readonly usable: boolean;
}

export interface JiraOAuthClientLike {
  readonly getStoredTokens: () => JiraTokens | null;
  readonly refresh: (refreshToken: string) => Promise<JiraTokens>;
  readonly authenticate: () => Promise<JiraTokens>;
}

export type BrowserOpener = (authorizationUrl: string) => unknown;

export interface JiraOAuthClientOptions {
  readonly clientId?: string;
  readonly clientSecret?: string;
  readonly openBrowser?: BrowserOpener;
  readonly port?: number;
  readonly scopes?: string[];
  readonly tokenStorePath?: string;
  readonly urls?: {
    readonly authUrl?: string;
    readonly resourcesUrl?: string;
    readonly tokenUrl?: string;
  };
}

export type JiraOAuthClientFactory = (
  options: JiraOAuthClientOptions,
) => JiraOAuthClientLike | Promise<JiraOAuthClientLike>;

export interface JiraAuthOptions extends JiraOAuthClientOptions {
  readonly clientFactory?: JiraOAuthClientFactory;
}

export interface JiraRequestOptions {
  readonly accessToken: string;
  readonly apiRoot?: string;
  readonly cloudId: string;
  readonly fetchImpl?: typeof fetch;
}

export interface FetchAssignedJiraIssuesOptions extends JiraRequestOptions {
  readonly maxResults?: number;
}

export interface JiraIssueKeyRequestOptions extends JiraRequestOptions {
  readonly issueKey: string;
}

export interface FetchJiraIssueDetailOptions extends JiraIssueKeyRequestOptions {
  readonly downloadImages?: boolean;
  readonly imageOutputDir?: string;
  readonly maxImageBytes?: number;
  readonly maxImages?: number;
}

export interface TransitionJiraIssueOptions extends JiraIssueKeyRequestOptions {
  readonly transitionId: string;
}

export interface AddJiraIssueWorklogOptions extends JiraIssueKeyRequestOptions {
  readonly comment?: string;
  readonly minutes: number;
  readonly started?: string;
}

export interface AssignedIssuesSearchBody {
  readonly fields: readonly string[];
  readonly jql: string;
  readonly maxResults: number;
}

export interface JiraIssueSummary {
  readonly assigneeDisplayName: string | null;
  readonly issueType: string;
  readonly key: string;
  readonly priority: string | null;
  readonly status: string;
  readonly statusCategory: string;
  readonly summary: string;
  readonly updated: string;
}

export interface JiraIssueComment {
  readonly authorDisplayName: string;
  readonly bodyText: string;
  readonly created: string;
  readonly id: string;
}

export interface JiraIssueAttachment {
  readonly filename: string;
  readonly id: string;
  readonly mimeType: string;
  readonly size: number;
}

export type JiraIssueImageSource = "description" | "comment";

export interface JiraIssueImageFile {
  readonly attachmentId: string;
  readonly byteLength: number;
  readonly commentId?: string;
  readonly filePath: string;
  readonly fileUrl: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly source: JiraIssueImageSource;
}

export interface JiraLinkedCloneIssue {
  readonly key: string;
  readonly relationship: string;
  readonly status: string | null;
}

export interface JiraIssueDetail extends JiraIssueSummary {
  readonly attachments: readonly JiraIssueAttachment[];
  readonly comments: readonly JiraIssueComment[];
  readonly descriptionText: string;
  readonly images: readonly JiraIssueImageFile[];
  readonly linkedCloneIssues: readonly JiraLinkedCloneIssue[];
}

export interface JiraIssueRemoteLink {
  readonly id: string;
  readonly relationship: string;
  readonly title: string;
  readonly url: string;
}

export interface JiraIssueTransition {
  readonly id: string;
  readonly name: string;
  readonly toStatus: string;
}

export interface FetchJiraCustomFieldsOptions extends JiraRequestOptions {
  readonly maxResults?: number;
}

export interface UpdateJiraIssueFieldsOptions extends JiraIssueKeyRequestOptions {
  readonly fields: Record<string, unknown>;
}
