import { describe, expect, it, vi } from "vitest";

import { buildInlineMediaAdfNode, resolveJiraAttachmentMediaId } from "../../src/media-embed.js";

const authorization = "Bearer secret-access-token";
const baseUrl = "https://jira-api.example.com/ex/jira/cloud-1";
type FetchInput = Parameters<typeof fetch>[0];

describe("resolveJiraAttachmentMediaId", () => {
  it("extracts the Media Services id from a redirect Location header", async () => {
    const fetchMock = vi.fn(async (_input: FetchInput, _init?: RequestInit) => await Promise.resolve(new Response(null, {
      headers: {
        location:
          "https://api.media.atlassian.com/file/11111111-2222-3333-4444-555555555555/binary?token=x&client=y",
      },
      status: 303,
    })));

    await expect(resolveJiraAttachmentMediaId({
      attachmentId: "20001",
      authorization,
      baseUrl,
      cloudId: "cloud-1",
      fetchImpl: fetchMock,
    })).resolves.toEqual({ mediaId: "11111111-2222-3333-4444-555555555555", reason: null });

    const [url, init] = fetchMock.mock.calls[0] as [FetchInput, RequestInit];
    expect(url).toBe(`${baseUrl}/rest/api/3/attachment/content/20001`);
    expect(init).toEqual({
      headers: { Accept: "*/*", Authorization: authorization },
      redirect: "manual",
    });
  });

  it("reports an unresolved outcome when the response is not a redirect", async () => {
    const fetchMock = vi.fn(async () => await Promise.resolve(new Response("ok", { status: 200 })));

    await expect(resolveJiraAttachmentMediaId({
      attachmentId: "20001",
      authorization,
      baseUrl,
      cloudId: "cloud-1",
      fetchImpl: fetchMock,
    })).resolves.toEqual({
      mediaId: null,
      reason: "Attachment content did not redirect (HTTP 200).",
    });
  });

  it("reports an unresolved outcome when the redirect has no Location header", async () => {
    const fetchMock = vi.fn(async () => await Promise.resolve(new Response(null, { status: 303 })));

    await expect(resolveJiraAttachmentMediaId({
      attachmentId: "20001",
      authorization,
      baseUrl,
      cloudId: "cloud-1",
      fetchImpl: fetchMock,
    })).resolves.toEqual({
      mediaId: null,
      reason: "Attachment content redirect had no Location header.",
    });
  });

  it("reports an unresolved outcome when the redirect does not expose a Media Services id", async () => {
    const fetchMock = vi.fn(async () => await Promise.resolve(new Response(null, {
      headers: { location: "https://forge-outbound-proxy.services.atlassian.com/fpp/provider/opaque" },
      status: 303,
    })));

    await expect(resolveJiraAttachmentMediaId({
      attachmentId: "20001",
      authorization,
      baseUrl,
      cloudId: "cloud-1",
      fetchImpl: fetchMock,
    })).resolves.toEqual({
      mediaId: null,
      reason: "Attachment content redirect did not expose a Media Services id.",
    });
  });

  it("reports an unresolved outcome instead of throwing on a network failure", async () => {
    const fetchMock = vi.fn(async () => await Promise.reject(new Error("secret-access-token leak check")));

    await expect(resolveJiraAttachmentMediaId({
      attachmentId: "20001",
      authorization,
      baseUrl,
      cloudId: "cloud-1",
      fetchImpl: fetchMock,
    })).resolves.toEqual({
      mediaId: null,
      reason: "Attachment content request failed.",
    });
  });
});

describe("buildInlineMediaAdfNode", () => {
  it("builds a one-image mediaSingle document with an empty collection", () => {
    expect(buildInlineMediaAdfNode("11111111-2222-3333-4444-555555555555")).toEqual({
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
                id: "11111111-2222-3333-4444-555555555555",
                type: "file",
              },
            },
          ],
        },
      ],
    });
  });

  it("includes width, height, and alt only when supplied", () => {
    const document = buildInlineMediaAdfNode("media-id", { alt: "screenshot.png", height: 225, width: 300 });
    expect(document.content[0]).toMatchObject({
      content: [
        {
          attrs: {
            alt: "screenshot.png",
            height: 225,
            width: 300,
          },
        },
      ],
    });
  });
});
