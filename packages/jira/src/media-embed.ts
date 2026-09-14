import type { JiraAdfDocument } from "./adf.js";
import type {
  JiraAttachmentMediaIdResolution,
  ResolveJiraAttachmentMediaIdOptions,
} from "./types.js";
import { buildJiraAttachmentContentUrl } from "./urls.js";

/**
 * Undocumented Jira behavior: the redirect target of the attachment content endpoint exposes the
 * Media Services file id between `/file/` and `/binary`. Atlassian gives no public API for this id
 * and can change the redirect shape without notice — treat every call here as best-effort.
 */
const MEDIA_FILE_ID_PATTERN =
  /\/file\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\/binary\b/u;

export interface InlineMediaAdfAttrs {
  readonly alt?: string;
  readonly height?: number;
  readonly width?: number;
}

export async function resolveJiraAttachmentMediaId(
  options: ResolveJiraAttachmentMediaIdOptions,
): Promise<JiraAttachmentMediaIdResolution> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = buildJiraAttachmentContentUrl(options.baseUrl, options.attachmentId);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { Accept: "*/*", Authorization: options.authorization },
      redirect: "manual",
    });
  } catch {
    return unresolved("Attachment content request failed.");
  }

  if (!isRedirectResponse(response)) {
    await cancelResponseBody(response);
    return unresolved(`Attachment content did not redirect (HTTP ${response.status.toString()}).`);
  }

  const location = response.headers.get("location");
  if (location === null) {
    return unresolved("Attachment content redirect had no Location header.");
  }

  const match = MEDIA_FILE_ID_PATTERN.exec(location);
  return match?.[1] === undefined
    ? unresolved("Attachment content redirect did not expose a Media Services id.")
    : { mediaId: match[1], reason: null };
}

/**
 * Builds a one-image ADF document: `mediaSingle > media`, ready to use as a comment body
 * (`addJiraIssueComment`) or an appended description fragment (`updateJiraIssueDescription` with
 * `mode: "append"`). `collection` is sent empty — live testing (2026-09-15, one tenant) found the
 * value made no observable difference to rendering, which matches community reports that a correct
 * collection is not obtainable through any public endpoint. This is empirical, not a guarantee.
 */
export function buildInlineMediaAdfNode(mediaId: string, attrs: InlineMediaAdfAttrs = {}): JiraAdfDocument {
  return {
    type: "doc",
    version: 1,
    content: [
      {
        type: "mediaSingle",
        attrs: { layout: "center" },
        content: [
          {
            type: "media",
            attrs: {
              collection: "",
              id: mediaId,
              type: "file",
              ...(attrs.width === undefined ? {} : { width: attrs.width }),
              ...(attrs.height === undefined ? {} : { height: attrs.height }),
              ...(attrs.alt === undefined ? {} : { alt: attrs.alt }),
            },
          },
        ],
      },
    ],
  };
}

function unresolved(reason: string): JiraAttachmentMediaIdResolution {
  return { mediaId: null, reason };
}

function isRedirectResponse(response: Response): boolean {
  return response.status >= 300 && response.status < 400;
}

async function cancelResponseBody(response: Response): Promise<void> {
  if (response.body !== null) {
    await response.body.cancel().catch(() => {
      /* ignore */
    });
  }
}
