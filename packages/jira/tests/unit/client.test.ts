import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { textToAdfDocument } from "../../src/adf.js";
import {
  addJiraIssueComment,
  addJiraIssueWorklog,
  assignJiraIssue,
  fetchAssignedJiraIssues,
  fetchJiraCurrentUser,
  fetchJiraCustomFields,
  fetchJiraIssueDescriptionAdf,
  fetchJiraIssueEditMetadata,
  fetchJiraIssueDetail,
  fetchJiraIssueRemoteLinks,
  fetchJiraIssueTransitions,
  searchJiraAssignableUsers,
  transitionJiraIssue,
  updateJiraIssueDescription,
  updateJiraIssueFields,
  updateJiraIssueSummary,
} from "../../src/client.js";
import { buildAssignedIssuesSearchBody } from "../../src/urls.js";

const apiRoot = "https://jira-api.example.com/ex/jira";
const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xdb]);
const tempDirs: string[] = [];
type FetchInput = Parameters<typeof fetch>[0];

afterEach(async () => {
  await Promise.all(
    tempDirs.map(async (dir) => {
      await rm(dir, { force: true, recursive: true });
    }),
  );
  tempDirs.length = 0;
});

describe("Jira REST client", () => {
  it("fetches assigned issues through enhanced JQL search", async () => {
    const fetchMock = vi.fn(async () => {
      return await Promise.resolve(
        jsonResponse({
          issues: [
            {
              key: "OPS-123",
              fields: {
                summary: "Stabilize deployment",
                status: { name: "In Progress", statusCategory: { name: "In Progress" } },
                priority: { name: "High" },
                assignee: { displayName: "Current User" },
                issuetype: { name: "Bug" },
                updated: "2026-05-01T08:20:00.000+0000",
              },
            },
          ],
        }),
      );
    });

    await expect(
      fetchAssignedJiraIssues({
        accessToken: "secret-access-token",
        apiRoot,
        cloudId: "cloud-1",
        fetchImpl: fetchMock,
      }),
    ).resolves.toEqual([
      {
        assigneeDisplayName: "Current User",
        issueType: "Bug",
        key: "OPS-123",
        priority: "High",
        status: "In Progress",
        statusCategory: "In Progress",
        summary: "Stabilize deployment",
        updated: "2026-05-01T08:20:00.000+0000",
      },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://jira-api.example.com/ex/jira/cloud-1/rest/api/3/search/jql",
      {
        body: JSON.stringify(buildAssignedIssuesSearchBody()),
        headers: {
          Accept: "application/json",
          Authorization: "Bearer secret-access-token",
          "Content-Type": "application/json",
        },
        method: "POST",
      },
    );
  });

  it("fetches issue detail and extracts readable ADF text", async () => {
    const descriptionAdf = {
      type: "doc",
      version: 1,
      content: [{ type: "paragraph", content: [{ type: "text", text: "Deploy safely" }] }],
    };
    const fetchMock = vi.fn(async () => {
      return await Promise.resolve(
        jsonResponse({
          key: "OPS-123",
          fields: {
            summary: "Stabilize deployment",
            status: { name: "In Progress", statusCategory: { name: "In Progress" } },
            priority: null,
            assignee: null,
            issuetype: { name: "Task" },
            updated: "2026-05-01T08:20:00.000+0000",
            description: descriptionAdf,
            comment: {
              comments: [
                {
                  id: "10001",
                  author: { displayName: "Reviewer" },
                  body: {
                    type: "doc",
                    content: [{ type: "paragraph", content: [{ type: "text", text: "Looks good" }] }],
                  },
                  created: "2026-05-01T09:00:00.000+0000",
                },
              ],
            },
            attachment: [{ id: "20001", filename: "diagram.png", mimeType: "image/png", size: 42 }],
            issuelinks: [
              {
                type: { name: "Cloners", outward: "clones" },
                outwardIssue: { key: "OPS-456", fields: { status: { name: "Done" } } },
              },
            ],
          },
        }),
      );
    });

    await expect(
      fetchJiraIssueDetail({
        accessToken: "secret-access-token",
        apiRoot,
        cloudId: "cloud-1",
        fetchImpl: fetchMock,
        issueKey: "OPS-123",
      }),
    ).resolves.toMatchObject({
      attachments: [{ filename: "diagram.png", id: "20001", mimeType: "image/png", size: 42 }],
      comments: [{ authorDisplayName: "Reviewer", bodyText: "Looks good" }],
      descriptionAdf,
      descriptionText: "Deploy safely",
      linkedCloneIssues: [{ key: "OPS-456", relationship: "clones", status: "Done" }],
      key: "OPS-123",
      priority: null,
    });
  });

  it("keeps issue detail robust when raw description ADF is missing or invalid", async () => {
    const fetchMock = vi.fn(async (input: FetchInput, _init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.includes("/comment?")) {
        return await Promise.resolve(jsonResponse({ comments: [], maxResults: 100, startAt: 0, total: 0 }));
      }
      if (url.includes("/OPS-129?")) {
        return await Promise.resolve(
          jsonResponse({
          key: "OPS-129",
          fields: {
            summary: "Invalid description shape",
            status: { name: "In Progress", statusCategory: { name: "In Progress" } },
            priority: null,
            assignee: null,
            issuetype: { name: "Task" },
            updated: "2026-05-01T08:20:00.000+0000",
            description: { type: "doc", version: 1, content: "not-array", text: "Readable fallback" },
            comment: { comments: [] },
            attachment: [],
            issuelinks: [],
          },
        }),
        );
      }
      return await Promise.resolve(
        jsonResponse({
          key: "OPS-130",
          fields: {
            summary: "No description",
            status: { name: "Open", statusCategory: { name: "To Do" } },
            priority: null,
            assignee: null,
            issuetype: { name: "Task" },
            updated: "2026-05-01T08:20:00.000+0000",
            description: null,
            comment: { comments: [] },
            attachment: [],
            issuelinks: [],
          },
        }),
      );
    });

    await expect(fetchJiraIssueDetail({
      accessToken: "secret-access-token",
      apiRoot,
      cloudId: "cloud-1",
      fetchImpl: fetchMock,
      issueKey: "OPS-129",
    })).resolves.toMatchObject({
      descriptionAdf: null,
      descriptionText: "Readable fallback",
    });
    await expect(fetchJiraIssueDetail({
      accessToken: "secret-access-token",
      apiRoot,
      cloudId: "cloud-1",
      fetchImpl: fetchMock,
      issueKey: "OPS-130",
    })).resolves.toMatchObject({
      descriptionAdf: null,
      descriptionText: "",
    });
  });

  it("fetches paginated issue comments and downloads inline comment images", async () => {
    const imageOutputDir = await createTempDir();
    const fetchMock = vi.fn(async (input: FetchInput, _init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.includes("/rest/api/3/issue/OPS-124?")) {
        return await Promise.resolve(
          jsonResponse({
            key: "OPS-124",
            fields: {
              summary: "Paginated comments",
              status: { name: "In Progress", statusCategory: { name: "In Progress" } },
              priority: null,
              assignee: null,
              issuetype: { name: "Task" },
              updated: "2026-05-01T08:20:00.000+0000",
              description: null,
              comment: { comments: [] },
              attachment: [{ id: "41001", filename: "comment.png", mimeType: "image/png", size: 8 }],
              issuelinks: [],
            },
          }),
        );
      }

      if (url.includes("/rest/api/3/issue/OPS-124/comment?startAt=0")) {
        return await Promise.resolve(
          jsonResponse({
            comments: [
              {
                id: "comment-1",
                author: { displayName: "Reviewer" },
                body: mediaDocument("comment.png", "41001"),
                created: "2026-05-01T09:00:00.000+0000",
              },
            ],
            maxResults: 1,
            startAt: 0,
            total: 2,
          }),
        );
      }

      if (url.includes("/rest/api/3/issue/OPS-124/comment?startAt=1")) {
        return await Promise.resolve(
          jsonResponse({
            comments: [
              {
                id: "comment-2",
                author: { displayName: "Tester" },
                body: {
                  type: "doc",
                  content: [{ type: "paragraph", content: [{ type: "text", text: "Second page" }] }],
                },
                created: "2026-05-01T10:00:00.000+0000",
              },
            ],
            maxResults: 1,
            startAt: 1,
            total: 2,
          }),
        );
      }

      return await Promise.resolve(
        new Response(pngBytes, {
          headers: { "Content-Type": "image/png" },
          status: 200,
        }),
      );
    });

    const detail = await fetchJiraIssueDetail({
      accessToken: "secret-access-token",
      apiRoot,
      cloudId: "cloud-1",
      downloadImages: true,
      fetchImpl: fetchMock,
      imageOutputDir,
      issueKey: "OPS-124",
      maxImageBytes: 64,
    });

    expect(detail.comments).toMatchObject([
      { authorDisplayName: "Reviewer", id: "comment-1" },
      { authorDisplayName: "Tester", bodyText: "Second page", id: "comment-2" },
    ]);
    expect(detail.images).toEqual([
      expect.objectContaining({
        attachmentId: "41001",
        commentId: "comment-1",
        filename: "comment.png",
        source: "comment",
      }),
    ]);
    expect(Object.hasOwn(detail.comments[0] ?? {}, "images")).toBe(false);
  });

  it("downloads inline description images to local temp files when requested", async () => {
    const imageOutputDir = await createTempDir();
    const fetchMock = vi.fn(async (input: FetchInput, _init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.includes("/rest/api/3/issue/OPS-125?")) {
        return await Promise.resolve(
          jsonResponse({
            key: "OPS-125",
            renderedFields: {
              description: '<p><img src="/rest/api/3/attachment/content/30001" /></p>',
            },
            fields: {
              summary: "Review inline image",
              status: { name: "In Progress", statusCategory: { name: "In Progress" } },
              priority: null,
              assignee: null,
              issuetype: { name: "Task" },
              updated: "2026-05-01T08:20:00.000+0000",
              description: mediaDocument("diagram.png", "media-platform-id"),
              comment: { comments: [] },
              attachment: [
                {
                  id: "30001",
                  filename: "diagram.png",
                  mimeType: "application/octet-stream",
                  size: pngBytes.byteLength,
                },
              ],
              issuelinks: [],
            },
          }),
        );
      }

      return await Promise.resolve(
        new Response(pngBytes, {
          headers: { "Content-Type": "application/octet-stream" },
          status: 200,
        }),
      );
    });

    const detail = await fetchJiraIssueDetail({
      accessToken: "secret-access-token",
      apiRoot,
      cloudId: "cloud-1",
      downloadImages: true,
      fetchImpl: fetchMock,
      imageOutputDir,
      issueKey: "OPS-125",
      maxImageBytes: 64,
    });

    expect(detail.images).toEqual([
      expect.objectContaining({
        attachmentId: "30001",
        byteLength: pngBytes.byteLength,
        filename: "diagram.png",
        mimeType: "image/png",
        source: "description",
      }),
    ]);
    const savedImage = detail.images[0];
    expect(savedImage?.filePath.startsWith(imageOutputDir)).toBe(true);
    expect(savedImage?.fileUrl.startsWith("file://")).toBe(true);
    await expect(readFile(savedImage?.filePath ?? "")).resolves.toEqual(Buffer.from(pngBytes));
    expect(detail.attachments[0]).toEqual({
      filename: "diagram.png",
      id: "30001",
      mimeType: "application/octet-stream",
      size: pngBytes.byteLength,
    });
    expect(Object.hasOwn(detail.attachments[0] ?? {}, "byteLength")).toBe(false);
    expect(Object.hasOwn(detail.attachments[0] ?? {}, "fileUrl")).toBe(false);
    expect(Object.hasOwn(detail.attachments[0] ?? {}, "localPath")).toBe(false);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://jira-api.example.com/ex/jira/cloud-1/rest/api/3/attachment/content/30001",
      {
        headers: {
          Accept: "*/*",
          Authorization: "Bearer secret-access-token",
        },
        redirect: "manual",
      },
    );
  });

  it("follows signed media redirects without forwarding Authorization headers", async () => {
    const imageOutputDir = await createTempDir();
    const fetchMock = vi.fn(async (input: FetchInput, _init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.includes("/rest/api/3/issue/OPS-126?")) {
        return await Promise.resolve(
          jsonResponse({
            key: "OPS-126",
            fields: {
              summary: "Review comment image",
              status: { name: "In Progress", statusCategory: { name: "In Progress" } },
              priority: null,
              assignee: null,
              issuetype: { name: "Task" },
              updated: "2026-05-01T08:20:00.000+0000",
              description: null,
              comment: {
                comments: [
                  {
                    id: "comment-1",
                    body: mediaDocument("alert.jpg", "40001"),
                    created: "2026-05-01T09:00:00.000+0000",
                  },
                ],
              },
              attachment: [
                { id: "40001", filename: "alert.jpg", mimeType: "image/jpeg", size: 4 },
              ],
              issuelinks: [],
            },
          }),
        );
      }

      if (url.includes("/attachment/content/40001")) {
        return await Promise.resolve(
          new Response(null, {
            headers: { Location: "https://api.media.atlassian.com/file/media-1/binary" },
            status: 302,
          }),
        );
      }

      return await Promise.resolve(
        new Response(jpegBytes, {
          headers: { "Content-Type": "application/octet-stream" },
          status: 200,
        }),
      );
    });

    const detail = await fetchJiraIssueDetail({
      accessToken: "secret-access-token",
      apiRoot,
      cloudId: "cloud-1",
      downloadImages: true,
      fetchImpl: fetchMock,
      imageOutputDir,
      issueKey: "OPS-126",
      maxImageBytes: 64,
    });

    expect(detail.images).toEqual([
      expect.objectContaining({
        attachmentId: "40001",
        commentId: "comment-1",
        filename: "alert.jpg",
        mimeType: "image/jpeg",
        source: "comment",
      }),
    ]);
    expect(Object.hasOwn(detail.comments[0] ?? {}, "images")).toBe(false);
    expect(fetchMock).toHaveBeenLastCalledWith(
      "https://api.media.atlassian.com/file/media-1/binary",
      {
        headers: {
          Accept: "image/*",
        },
      },
    );
  });

  it("skips inline image downloads when the image body exceeds the byte limit", async () => {
    const imageOutputDir = await createTempDir();
    const fetchMock = vi.fn(async (input: FetchInput, _init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.includes("/rest/api/3/issue/OPS-127?")) {
        return await Promise.resolve(
          jsonResponse({
            key: "OPS-127",
            fields: {
              summary: "Oversized image",
              status: { name: "In Progress", statusCategory: { name: "In Progress" } },
              priority: null,
              assignee: null,
              issuetype: { name: "Task" },
              updated: "2026-05-01T08:20:00.000+0000",
              description: mediaDocument("large.png", "50001"),
              comment: { comments: [] },
              attachment: [{ id: "50001", filename: "large.png", mimeType: "image/png", size: 4 }],
              issuelinks: [],
            },
          }),
        );
      }

      return await Promise.resolve(
        new Response(pngBytes, {
          headers: {
            "Content-Length": pngBytes.byteLength.toString(),
            "Content-Type": "image/png",
          },
          status: 200,
        }),
      );
    });

    await expect(
      fetchJiraIssueDetail({
        accessToken: "secret-access-token",
        apiRoot,
        cloudId: "cloud-1",
        downloadImages: true,
        fetchImpl: fetchMock,
        imageOutputDir,
        issueKey: "OPS-127",
        maxImageBytes: 3,
      }),
    ).resolves.toMatchObject({
      images: [],
    });
  });

  it("fetches remote links and transitions", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse([
          {
            id: 10001,
            relationship: "Runbook",
            object: { title: "Service Runbook", url: "https://docs.example.com/runbook" },
          },
        ]),
      )
      .mockResolvedValueOnce(
        jsonResponse({ transitions: [{ id: "31", name: "Start Review", to: { name: "Review" } }] }),
      );

    await expect(
      fetchJiraIssueRemoteLinks({
        accessToken: "secret-access-token",
        apiRoot,
        cloudId: "cloud-1",
        fetchImpl: fetchMock,
        issueKey: "OPS-123",
      }),
    ).resolves.toEqual([
      {
        id: "10001",
        relationship: "Runbook",
        title: "Service Runbook",
        url: "https://docs.example.com/runbook",
      },
    ]);
    await expect(
      fetchJiraIssueTransitions({
        accessToken: "secret-access-token",
        apiRoot,
        cloudId: "cloud-1",
        fetchImpl: fetchMock,
        issueKey: "OPS-123",
      }),
    ).resolves.toEqual([{ id: "31", name: "Start Review", toStatus: "Review" }]);
  });

  it("covers fallback mapping for remote links, transitions, and sparse details", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse([{ id: "10002", object: { title: "Dashboard", url: "https://dash.example.com" } }]),
      )
      .mockResolvedValueOnce(jsonResponse({ transitions: [{ id: "41", name: "Done" }] }))
      .mockResolvedValueOnce(
        jsonResponse({
          key: "OPS-124",
          fields: {
            summary: "Sparse issue",
            status: { name: "Open", statusCategory: { name: "To Do" } },
            issuetype: { name: "Task" },
            updated: "2026-05-01T08:20:00.000+0000",
            comment: [{ body: null }],
            attachment: [{ id: 20002, filename: "notes.txt", mimeType: "text/plain" }],
            issuelinks: [
              {
                type: { name: "Cloners", inward: "clones" },
                inwardIssue: { key: "OPS-100" },
              },
              {
                type: { name: "Relates", outward: "relates to" },
                outwardIssue: { key: "OPS-200" },
              },
            ],
          },
        }),
      );

    await expect(
      fetchJiraIssueRemoteLinks({
        accessToken: "secret-access-token",
        apiRoot,
        cloudId: "cloud-1",
        fetchImpl: fetchMock,
        issueKey: "OPS-124",
      }),
    ).resolves.toEqual([
      {
        id: "10002",
        relationship: "Remote link",
        title: "Dashboard",
        url: "https://dash.example.com",
      },
    ]);
    await expect(
      fetchJiraIssueTransitions({
        accessToken: "secret-access-token",
        apiRoot,
        cloudId: "cloud-1",
        fetchImpl: fetchMock,
        issueKey: "OPS-124",
      }),
    ).resolves.toEqual([{ id: "41", name: "Done", toStatus: "Done" }]);
    await expect(
      fetchJiraIssueDetail({
        accessToken: "secret-access-token",
        apiRoot,
        cloudId: "cloud-1",
        fetchImpl: fetchMock,
        issueKey: "OPS-124",
      }),
    ).resolves.toMatchObject({
      assigneeDisplayName: null,
      attachments: [{ id: "20002", size: 0 }],
      comments: [{ authorDisplayName: "Unknown author", bodyText: "", id: "comment-0" }],
      descriptionText: "",
      linkedCloneIssues: [{ key: "OPS-100", relationship: "clones", status: null }],
      priority: null,
    });
  });

  it("sends Jira write requests with neutral errors", async () => {
    const transitionFetch = vi.fn(async () => await Promise.resolve(new Response(null, { status: 204 })));
    await expect(
      transitionJiraIssue({
        accessToken: "secret-access-token",
        apiRoot,
        cloudId: "cloud-1",
        fetchImpl: transitionFetch,
        issueKey: "OPS-123",
        transitionId: "31",
      }),
    ).resolves.toBeUndefined();

    const worklogFetch = vi.fn(async () => await Promise.resolve(new Response("denied secret-access-token", { status: 403 })));
    await expect(
      addJiraIssueWorklog({
        accessToken: "secret-access-token",
        apiRoot,
        cloudId: "cloud-1",
        fetchImpl: worklogFetch,
        issueKey: "OPS-123",
        minutes: 30,
        started: "2026-05-01T08:20:00.000+0000",
      }),
    ).rejects.toThrow("Jira worklog could not be added.");
    await expect(
      addJiraIssueWorklog({
        accessToken: "secret-access-token",
        apiRoot,
        cloudId: "cloud-1",
        fetchImpl: worklogFetch,
        issueKey: "OPS-123",
        minutes: 30,
      }),
    ).rejects.not.toThrow(/secret-access-token/);
  });

  it("adds worklogs without comments and validates positive minutes", async () => {
    const fetchMock = vi.fn(async () => await Promise.resolve(new Response("{}", { status: 201 })));

    await expect(
      addJiraIssueWorklog({
        accessToken: "secret-access-token",
        apiRoot,
        cloudId: "cloud-1",
        fetchImpl: fetchMock,
        issueKey: "OPS-123",
        minutes: 15,
        started: "2026-05-01T08:20:00.000+0000",
      }),
    ).resolves.toBeUndefined();
    const request = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(request.body).toBe(
      JSON.stringify({
        started: "2026-05-01T08:20:00.000+0000",
        timeSpentSeconds: 900,
      }),
    );

    await expect(
      addJiraIssueWorklog({
        accessToken: "secret-access-token",
        apiRoot,
        cloudId: "cloud-1",
        fetchImpl: fetchMock,
        issueKey: "OPS-123",
        minutes: 0,
      }),
    ).rejects.toThrow("positive integer");
  });


  it("fetches paginated custom fields and issue edit metadata", async () => {
    const fetchMock = vi.fn(async (input: FetchInput, _init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.includes("startAt=0")) {
        return await Promise.resolve(jsonResponse({ startAt: 0, maxResults: 1, total: 2, values: [{ id: "customfield_10101", name: "Custom text A", schema: { type: "string", custom: "com.atlassian.jira.plugin.system.customfieldtypes:textarea", customId: 10101 } }] }));
      }
      return await Promise.resolve(jsonResponse({ startAt: 1, maxResults: 1, total: 2, isLast: true, values: [{ id: "customfield_10102", key: "customfield_10102", name: "Custom text B", schema: { type: "string", custom: "com.atlassian.jira.plugin.system.customfieldtypes:textfield", customId: 10102 } }] }));
    });

    const result = await fetchJiraCustomFields({ accessToken: "secret-access-token", apiRoot, cloudId: "cloud-1", fetchImpl: fetchMock, maxResults: 1 });

    expect(result.totalFromApi).toBe(2);
    expect(result.fields.map((field) => field.name)).toEqual(["Custom text A", "Custom text B"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("maps editable custom fields and updates issue fields", async () => {
    const editFetch = vi.fn(async () => await Promise.resolve(jsonResponse({ fields: { customfield_10101: { name: "Custom text A", required: false, allowedValues: [], schema: { type: "string", custom: "com.atlassian.jira.plugin.system.customfieldtypes:textarea", customId: 10101 } } } })));
    await expect(fetchJiraIssueEditMetadata({ accessToken: "secret-access-token", apiRoot, cloudId: "cloud-1", fetchImpl: editFetch, issueKey: "OPS-123" }))
      .resolves.toEqual(new Map([["customfield_10101", { id: "customfield_10101", name: "Custom text A", required: false, allowedValues: [], schema: { type: "string", custom: "com.atlassian.jira.plugin.system.customfieldtypes:textarea", customId: 10101, items: null } }]]));

    const updateFetch = vi.fn(async () => await Promise.resolve(new Response(null, { status: 204 })));
    await expect(updateJiraIssueFields({
      accessToken: "secret-access-token",
      apiRoot,
      cloudId: "cloud-1",
      fetchImpl: updateFetch,
      issueKey: "OPS-123",
      fields: { customfield_10101: "done" },
    })).resolves.toBeUndefined();
    expect(updateFetch).toHaveBeenCalledWith(
      "https://jira-api.example.com/ex/jira/cloud-1/rest/api/3/issue/OPS-123",
      expect.objectContaining({
        body: JSON.stringify({ fields: { customfield_10101: "done" } }),
        method: "PUT",
      }),
    );
  });

  it("fetches the current description ADF for media-safety checks", async () => {
    const description = mediaDocument("diagram.png", "media-platform-id");
    const fetchMock = vi.fn(async () => await Promise.resolve(jsonResponse({
      fields: { description },
    })));

    await expect(fetchJiraIssueDescriptionAdf({
      accessToken: "secret-access-token",
      apiRoot,
      cloudId: "cloud-1",
      fetchImpl: fetchMock,
      issueKey: "OPS-123",
    })).resolves.toEqual(description);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://jira-api.example.com/ex/jira/cloud-1/rest/api/3/issue/OPS-123?fields=description",
      {
        headers: {
          Accept: "application/json",
          Authorization: "Bearer secret-access-token",
        },
      },
    );
  });

  it("adds issue comments with validated ADF bodies", async () => {
    const body = textToAdfDocument("First line\nSecond line");
    const fetchMock = vi.fn(async () => await Promise.resolve(jsonResponse({ id: 10101, body }, 201)));

    await expect(addJiraIssueComment({
      accessToken: "secret-access-token",
      apiRoot,
      body,
      cloudId: "cloud-1",
      fetchImpl: fetchMock,
      issueKey: "OPS-123",
    })).resolves.toEqual({ id: "10101" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://jira-api.example.com/ex/jira/cloud-1/rest/api/3/issue/OPS-123/comment",
      {
        body: JSON.stringify({ body }),
        headers: {
          Accept: "application/json",
          Authorization: "Bearer secret-access-token",
          "Content-Type": "application/json",
        },
        method: "POST",
      },
    );
  });

  it("updates summaries only after editability checks", async () => {
    const fetchMock = vi.fn(async (input: FetchInput, _init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.endsWith("/editmeta")) {
        return await Promise.resolve(jsonResponse(systemEditMetadata()));
      }
      return await Promise.resolve(new Response(null, { status: 204 }));
    });

    await expect(updateJiraIssueSummary({
      accessToken: "secret-access-token",
      apiRoot,
      cloudId: "cloud-1",
      fetchImpl: fetchMock,
      issueKey: "OPS-123",
      notifyUsers: false,
      summary: "New title",
    })).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenLastCalledWith(
      "https://jira-api.example.com/ex/jira/cloud-1/rest/api/3/issue/OPS-123?notifyUsers=false",
      expect.objectContaining({
        body: JSON.stringify({ fields: { summary: "New title" } }),
        method: "PUT",
      }),
    );

    const lockedFetch = vi.fn(async () => await Promise.resolve(jsonResponse({ fields: {} })));
    await expect(updateJiraIssueSummary({
      accessToken: "secret-access-token",
      apiRoot,
      cloudId: "cloud-1",
      fetchImpl: lockedFetch,
      issueKey: "OPS-123",
      summary: "New title",
    })).rejects.toThrow('Jira field "summary" is not editable on OPS-123');
    expect(lockedFetch).toHaveBeenCalledTimes(1);
  });

  it("refuses plain-text description replacement when the current description contains media", async () => {
    const fetchMock = vi.fn(async (input: FetchInput, _init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.endsWith("/editmeta")) {
        return await Promise.resolve(jsonResponse(systemEditMetadata()));
      }
      if (url.endsWith("?fields=description")) {
        return await Promise.resolve(jsonResponse({
          fields: { description: mediaDocument("diagram.png", "media-platform-id") },
        }));
      }
      return await Promise.resolve(new Response(null, { status: 204 }));
    });

    await expect(updateJiraIssueDescription({
      accessToken: "secret-access-token",
      apiRoot,
      cloudId: "cloud-1",
      description: textToAdfDocument("Replacement"),
      fetchImpl: fetchMock,
      inputKind: "plain-text",
      issueKey: "OPS-123",
    })).rejects.toThrow("contains media");
    await expect(updateJiraIssueDescription({
      accessToken: "secret-access-token",
      apiRoot,
      cloudId: "cloud-1",
      description: textToAdfDocument("Replacement"),
      fetchImpl: fetchMock,
      inputKind: "plain-text",
      issueKey: "OPS-123",
    })).rejects.not.toThrow(/secret-access-token/u);
    expect(fetchMock.mock.calls.some((call) => requestUrl(call[0]).includes("notifyUsers"))).toBe(false);
    expect(fetchMock.mock.calls.some((call) => call[1]?.method === "PUT")).toBe(false);
  });

  it("allows forced plain-text description replacement", async () => {
    const fetchMock = vi.fn(async (input: FetchInput, _init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.endsWith("/editmeta")) {
        return await Promise.resolve(jsonResponse(systemEditMetadata()));
      }
      if (url.endsWith("?fields=description")) {
        return await Promise.resolve(jsonResponse({
          fields: { description: mediaDocument("diagram.png", "media-platform-id") },
        }));
      }
      return await Promise.resolve(new Response(null, { status: 204 }));
    });

    const replacement = textToAdfDocument("Replacement");
    await expect(updateJiraIssueDescription({
      accessToken: "secret-access-token",
      apiRoot,
      cloudId: "cloud-1",
      description: replacement,
      fetchImpl: fetchMock,
      force: true,
      inputKind: "plain-text",
      issueKey: "OPS-123",
    })).resolves.toBeUndefined();
    const put = fetchMock.mock.calls.find((call) => call[1]?.method === "PUT");
    expect(put?.[1]?.body).toBe(JSON.stringify({ fields: { description: replacement } }));
  });

  it("appends description ADF without dropping existing media content", async () => {
    const currentDescription = mediaDocument("diagram.png", "media-platform-id");
    const fetchMock = vi.fn(async (input: FetchInput, _init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.endsWith("/editmeta")) {
        return await Promise.resolve(jsonResponse(systemEditMetadata()));
      }
      if (url.endsWith("?fields=description")) {
        return await Promise.resolve(jsonResponse({ fields: { description: currentDescription } }));
      }
      return await Promise.resolve(new Response(null, { status: 204 }));
    });

    await expect(updateJiraIssueDescription({
      accessToken: "secret-access-token",
      apiRoot,
      cloudId: "cloud-1",
      description: textToAdfDocument("Appendix"),
      fetchImpl: fetchMock,
      inputKind: "plain-text",
      issueKey: "OPS-123",
      mode: "append",
    })).resolves.toBeUndefined();

    const put = fetchMock.mock.calls.find((call) => call[1]?.method === "PUT");
    const rawBody = put?.[1]?.body;
    expect(typeof rawBody).toBe("string");
    const body = JSON.parse(typeof rawBody === "string" ? rawBody : "{}") as {
      readonly fields: { readonly description: { readonly content: readonly unknown[] } };
    };
    expect(body.fields.description.content).toHaveLength(2);
    expect(JSON.stringify(body.fields.description)).toContain("media-platform-id");
    expect(JSON.stringify(body.fields.description)).toContain("Appendix");
  });

  it("treats raw ADF description replacement as an explicit full document", async () => {
    const rawDescription = {
      type: "doc" as const,
      version: 1,
      content: [{ type: "paragraph", content: [{ type: "text", text: "Raw replacement" }] }],
    };
    const fetchMock = vi.fn(async (input: FetchInput, _init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.endsWith("/editmeta")) {
        return await Promise.resolve(jsonResponse(systemEditMetadata()));
      }
      return await Promise.resolve(new Response(null, { status: 204 }));
    });

    await expect(updateJiraIssueDescription({
      accessToken: "secret-access-token",
      apiRoot,
      cloudId: "cloud-1",
      description: rawDescription,
      fetchImpl: fetchMock,
      inputKind: "adf",
      issueKey: "OPS-123",
    })).resolves.toBeUndefined();
    const put = fetchMock.mock.calls.find((call) => call[1]?.method === "PUT");
    expect(put?.[1]?.body).toBe(JSON.stringify({ fields: { description: rawDescription } }));
  });

  it("throws neutral validation errors for malformed Jira responses", async () => {
    const invalidFetch = vi.fn(async () => await Promise.resolve(jsonResponse({ invalid: true })));

    await expect(
      fetchAssignedJiraIssues({
        accessToken: "secret-access-token",
        apiRoot,
        cloudId: "cloud-1",
        fetchImpl: invalidFetch,
      }),
    ).rejects.toThrow("Assigned Jira issue response was not valid.");
    await expect(
      fetchJiraIssueRemoteLinks({
        accessToken: "secret-access-token",
        apiRoot,
        cloudId: "cloud-1",
        fetchImpl: invalidFetch,
        issueKey: "OPS-123",
      }),
    ).rejects.toThrow("Jira remote links response was not valid.");
    await expect(
      fetchJiraIssueTransitions({
        accessToken: "secret-access-token",
        apiRoot,
        cloudId: "cloud-1",
        fetchImpl: invalidFetch,
        issueKey: "OPS-123",
      }),
    ).rejects.toThrow("Jira issue transitions response was not valid.");
  });

  it("fetches current users, issue-scoped assignable users, and assigns by account ID", async () => {
    const fetchMock = vi.fn(async (input: FetchInput, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.endsWith("/rest/api/3/myself")) {
        return await Promise.resolve(jsonResponse({ accountId: "account-1", active: true, displayName: "Current User" }));
      }
      if (url.includes("/rest/api/3/user/assignable/search")) {
        return await Promise.resolve(jsonResponse([{ accountId: "account-1", active: true, displayName: "Current User" }]));
      }
      expect(init?.method).toBe("PUT");
      return await Promise.resolve(new Response(null, { status: 204 }));
    });

    await expect(fetchJiraCurrentUser({
      accessToken: "secret-access-token",
      apiRoot,
      cloudId: "cloud-1",
      fetchImpl: fetchMock,
    })).resolves.toMatchObject({ accountId: "account-1" });
    await expect(searchJiraAssignableUsers({
      accessToken: "secret-access-token",
      apiRoot,
      cloudId: "cloud-1",
      fetchImpl: fetchMock,
      issueKey: "OPS-123",
      query: "Current",
    })).resolves.toHaveLength(1);
    await expect(assignJiraIssue({
      accessToken: "secret-access-token",
      accountId: "account-1",
      apiRoot,
      cloudId: "cloud-1",
      fetchImpl: fetchMock,
      issueKey: "OPS/123",
    })).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenLastCalledWith(
      "https://jira-api.example.com/ex/jira/cloud-1/rest/api/3/issue/OPS%2F123/assignee",
      {
        body: JSON.stringify({ accountId: "account-1" }),
        headers: {
          Accept: "application/json",
          Authorization: "Bearer secret-access-token",
          "Content-Type": "application/json",
        },
        method: "PUT",
      },
    );
  });

  it.each([400, 401, 403, 404, 429, 500])("throws neutral assignment errors for HTTP %i", async (status) => {
    const fetchMock = vi.fn(async () => await Promise.resolve(new Response("sensitive body", { status })));
    await expect(assignJiraIssue({
      accessToken: "secret-access-token",
      accountId: "account-1",
      apiRoot,
      cloudId: "cloud-1",
      fetchImpl: fetchMock,
      issueKey: "OPS-123",
    })).rejects.toThrow("Jira issue assignee could not be updated.");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    status,
  });
}

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "saptools-jira-images-test-"));
  tempDirs.push(dir);
  return dir;
}

function mediaDocument(filename: string, mediaId: string): unknown {
  return {
    content: [
      {
        content: [{ attrs: { alt: filename, id: mediaId, type: "file" }, type: "media" }],
        type: "mediaSingle",
      },
    ],
    type: "doc",
    version: 1,
  };
}

function systemEditMetadata(): unknown {
  return {
    fields: {
      description: {
        name: "Description",
        required: false,
        schema: { type: "string" },
      },
      summary: {
        name: "Summary",
        required: true,
        schema: { type: "string" },
      },
    },
  };
}

function requestUrl(input: FetchInput): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}
