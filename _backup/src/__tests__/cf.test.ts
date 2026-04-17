import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  parseOrgList,
  parseOrgsTable,
  parseSpaceList,
  parseSpacesTable,
  parseAppNames,
  extractVcapServicesJson,
  cfApi,
  cfAuth,
  cfOrgs,
  cfTarget,
  cfTargetSpace,
  cfApps,
  cfSpaces,
  cfEnv,
} from "../cf.js";

// ─────────────────────────────────────────────────────────────────
// Real-world stdout fixtures — captured from live cf CLI sessions
// ─────────────────────────────────────────────────────────────────

const CF_LOGIN_STDOUT = `
API endpoint: https://api.cf.ap11.hana.ondemand.com

Authenticating...
OK

Select an org:
1. partnerorg-sg-dev-demoapp
2. acmecorp-dev-democorp

Org (enter to skip):
API endpoint:   https://api.cf.ap11.hana.ondemand.com
`;

const CF_TARGET_STDOUT = `
api endpoint:   https://api.cf.ap11.hana.ondemand.com
api version:    3.215.0
user:           johndoe@democorp.com
org:            acmecorp-dev-democorp
space:          app
`;

const CF_APPS_STDOUT = `
Getting apps in org acmecorp-dev-democorp / space app as johndoe@democorp.com...

name                               requested state   processes   routes
demoapp-db-background            started           web:0/0
demoapp-db-bp                    started           web:0/0
demoapp-db-prd                   started           web:0/0
demoapp-srv-background           stopped           web:0/1     example.cfapps.ap11.hana.ondemand.com
`;

const CF_ENV_STDOUT = `
Getting env variables for app demoapp-db-prd...
OK

System-Provided:
VCAP_SERVICES: {
  "hana": [
    {
      "credentials": {
        "host": "feb62cb7.hana.prod-ap11.hanacloud.ondemand.com",
        "port": "443"
      }
    }
  ]
}

VCAP_APPLICATION: {
  "application_name": "demoapp-db-prd"
}
`;

// vi.hoisted() runs before vi.mock() factories — required in ESM to avoid
// "Cannot access before initialization" errors when referencing the mock fn.
const { mockExecFile } = vi.hoisted(() => ({
  mockExecFile: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFile: mockExecFile,
}));

// promisify wraps execFile — we need the mock to behave like a
// node-style callback function so promisify can wrap it correctly.
function resolveExecFile(stdout: string): void {
  mockExecFile.mockImplementation(
    (
      _cmd: string,
      _args: string[],
      callback: (err: Error | null, result: { stdout: string; stderr: string }) => void,
    ) => {
      callback(null, { stdout, stderr: "" });
    },
  );
}

function rejectExecFile(message: string): void {
  mockExecFile.mockImplementation(
    (
      _cmd: string,
      _args: string[],
      callback: (err: Error) => void,
    ) => {
      callback(new Error(message));
    },
  );
}

// ─────────────────────────────────────────────────────────────────
// Pure parse function tests — pure functions, no mocking needed
// ─────────────────────────────────────────────────────────────────

describe("parseOrgList", () => {
  it("parses two orgs from real cf login output", () => {
    expect(parseOrgList(CF_LOGIN_STDOUT)).toEqual([
      "partnerorg-sg-dev-demoapp",
      "acmecorp-dev-democorp",
    ]);
  });

  it("returns empty array when no numbered lines exist", () => {
    expect(parseOrgList("Authenticating...\nOK\n")).toEqual([]);
  });

  it("handles a single org", () => {
    expect(parseOrgList("1. only-org\n")).toEqual(["only-org"]);
  });

  it("trims trailing/leading whitespace from org names", () => {
    expect(parseOrgList("1.   org-with-spaces   \n")).toEqual(["org-with-spaces"]);
  });

  it("handles 22-org list like real br10 output", () => {
    const lines = Array.from({ length: 22 }, (_, i) => `${String(i + 1)}. org-${String(i + 1)}`).join("\n");
    const orgs = parseOrgList(lines);

    expect(orgs).toHaveLength(22);
    expect(orgs[0]).toBe("org-1");
    expect(orgs[21]).toBe("org-22");
  });
});

describe("parseSpaceList", () => {
  it("parses single space from cf target output", () => {
    expect(parseSpaceList(CF_TARGET_STDOUT)).toEqual(["app"]);
  });

  it("parses multiple spaces when present", () => {
    const stdout = "space:          staging\nspace:          app\n";

    expect(parseSpaceList(stdout)).toEqual(["staging", "app"]);
  });

  it("returns empty array when no space line is found", () => {
    expect(parseSpaceList("org: my-org\nno space here\n")).toEqual([]);
  });

  it("handles extra whitespace around space name", () => {
    expect(parseSpaceList("space:    development  \n")).toEqual(["development"]);
  });
});

describe("parseAppNames", () => {
  it("parses all four app names from real cf apps output", () => {
    expect(parseAppNames(CF_APPS_STDOUT)).toEqual([
      "demoapp-db-background",
      "demoapp-db-bp",
      "demoapp-db-prd",
      "demoapp-srv-background",
    ]);
  });

  it("returns empty array when header exists but no app rows", () => {
    expect(parseAppNames("name  requested state  processes  routes\n")).toEqual([]);
  });

  it("returns empty array when no header row at all", () => {
    expect(parseAppNames("some random output")).toEqual([]);
  });

  it("skips blank lines between app rows", () => {
    const stdout = "name  state\napp-one  started\n\napp-two  stopped\n";

    expect(parseAppNames(stdout)).toEqual(["app-one", "app-two"]);
  });

  it("only returns first word on each line as app name", () => {
    const stdout = "name  state  processes\nmy-app  started  web:1/1  my-app.cfapps.com\n";

    expect(parseAppNames(stdout)).toEqual(["my-app"]);
  });
});

describe("extractVcapServicesJson", () => {
  it("extracts the VCAP_SERVICES JSON block and trims whitespace", () => {
    const result = extractVcapServicesJson(CF_ENV_STDOUT);

    expect(result).toContain('"hana"');
    expect(result).toContain("feb62cb7");
    expect(result.startsWith("{")).toBe(true);
    expect(result).not.toContain("VCAP_APPLICATION");
  });

  it("throws when VCAP_SERVICES marker is not in output", () => {
    expect(() => extractVcapServicesJson("no vcap here")).toThrow(
      "VCAP_SERVICES section not found",
    );
  });

  it("returns remainder of string when VCAP_APPLICATION absent", () => {
    const result = extractVcapServicesJson('VCAP_SERVICES: { "hana": [] }');

    expect(result).toBe('{ "hana": [] }');
  });

  it("does not include content after VCAP_APPLICATION marker", () => {
    const stdout = `VCAP_SERVICES: {"redis":[]}\nVCAP_APPLICATION: {"name":"app"}`;
    const result = extractVcapServicesJson(stdout);

    expect(result).toBe('{"redis":[]}');
    expect(result).not.toContain("application");
  });
});

// ─────────────────────────────────────────────────────────────────
// Async wrapper tests — cf commands use mocked execFile
// ─────────────────────────────────────────────────────────────────

const CF_ORGS_STDOUT = `Getting orgs as johndoe@democorp.com...

name
partnerorg-sg-dev-demoapp
acmecorp-dev-democorp
`;

describe("parseOrgsTable", () => {
  it("parses real cf orgs table output", () => {
    expect(parseOrgsTable(CF_ORGS_STDOUT)).toEqual([
      "partnerorg-sg-dev-demoapp",
      "acmecorp-dev-democorp",
    ]);
  });

  it("returns empty array when no name header found", () => {
    expect(parseOrgsTable("Getting orgs...\n\nnot a table\n")).toEqual([]);
  });

  it("handles single org", () => {
    expect(parseOrgsTable("name\nonly-org\n")).toEqual(["only-org"]);
  });

  it("skips blank lines after header", () => {
    expect(parseOrgsTable("name\n\norg-one\norg-two\n")).toEqual(["org-one", "org-two"]);
  });
});

describe("cfApi", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("resolves without error on success", async () => {
    resolveExecFile("Setting api endpoint...\nOK\n");

    await expect(cfApi("https://api.cf.ap11.hana.ondemand.com")).resolves.toBeUndefined();
  });

  it("propagates error when endpoint is unreachable", async () => {
    rejectExecFile("Could not target api endpoint");

    await expect(cfApi("https://invalid.endpoint.com")).rejects.toThrow("Could not target api endpoint");
  });
});

describe("cfAuth", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("resolves without error on valid credentials", async () => {
    resolveExecFile("Authenticating...\nOK\n");

    await expect(cfAuth("user@test.com", "pass")).resolves.toBeUndefined();
  });

  it("propagates error when credentials are invalid", async () => {
    rejectExecFile("Authentication failed");

    await expect(cfAuth("bad@user.com", "wrong")).rejects.toThrow("Authentication failed");
  });
});

describe("cfOrgs", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("returns parsed org list from cf orgs table output", async () => {
    resolveExecFile(CF_ORGS_STDOUT);

    const orgs = await cfOrgs();

    expect(orgs).toEqual(["partnerorg-sg-dev-demoapp", "acmecorp-dev-democorp"]);
  });

  it("returns empty array when user has no orgs", async () => {
    resolveExecFile("Getting orgs...\n\nname\n");

    expect(await cfOrgs()).toEqual([]);
  });

  it("propagates error when cf orgs fails", async () => {
    rejectExecFile("Not authenticated");

    await expect(cfOrgs()).rejects.toThrow("Not authenticated");
  });
});

describe("cfTarget", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("returns parsed space list from cf target output", async () => {
    resolveExecFile(CF_TARGET_STDOUT);

    const result = await cfTarget("acmecorp-dev-democorp");

    expect(result.spaces).toEqual(["app"]);
  });

  it("propagates error when org is not found", async () => {
    rejectExecFile("Organization 'unknown' not found");

    await expect(cfTarget("unknown")).rejects.toThrow("Organization 'unknown' not found");
  });
});

describe("cfTargetSpace", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("resolves without error on success", async () => {
    resolveExecFile("OK\n");

    await expect(cfTargetSpace("my-org", "my-space")).resolves.toBeUndefined();
  });

  it("propagates error when cf target -s fails", async () => {
    rejectExecFile("Space not found");

    await expect(cfTargetSpace("my-org", "bad-space")).rejects.toThrow("Space not found");
  });
});

describe("cfApps", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("returns all four app names from real output", async () => {
    resolveExecFile(CF_APPS_STDOUT);

    const apps = await cfApps();

    expect(apps).toEqual([
      "demoapp-db-background",
      "demoapp-db-bp",
      "demoapp-db-prd",
      "demoapp-srv-background",
    ]);
  });

  it("returns empty array when space has no apps", async () => {
    resolveExecFile("name  requested state  processes  routes\n");

    expect(await cfApps()).toEqual([]);
  });

  it("propagates error when cf command fails", async () => {
    rejectExecFile("No org targeted");

    await expect(cfApps()).rejects.toThrow("No org targeted");
  });
});

describe("cfEnv", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("returns extracted VCAP_SERVICES JSON block", async () => {
    resolveExecFile(CF_ENV_STDOUT);

    const result = await cfEnv("demoapp-db-prd");

    expect(result).toContain('"hana"');
    expect(result).toContain("feb62cb7");
  });

  it("throws when app has no VCAP_SERVICES", async () => {
    resolveExecFile("No environment variables found\n");

    await expect(cfEnv("no-vcap-app")).rejects.toThrow("VCAP_SERVICES section not found");
  });

  it("propagates cf command error", async () => {
    rejectExecFile("App not found");

    await expect(cfEnv("missing-app")).rejects.toThrow("App not found");
  });
});
// ─────────────────────────────────────────────────────────────────
// parseSpacesTable
// ─────────────────────────────────────────────────────────────────

const CF_SPACES_STDOUT = `Getting spaces in org acmecorp-dev-democorp as user@example.com...

name
app
dev
`;

describe("parseSpacesTable", () => {
  it("extracts space names after the 'name' header", () => {
    expect(parseSpacesTable(CF_SPACES_STDOUT)).toEqual(["app", "dev"]);
  });

  it("returns empty array when no 'name' header found", () => {
    expect(parseSpacesTable("No spaces found.")).toEqual([]);
  });

  it("ignores blank lines", () => {
    const stdout = "name\n\napp\n\n";

    expect(parseSpacesTable(stdout)).toEqual(["app"]);
  });

  it("handles single space", () => {
    expect(parseSpacesTable("name\nprod\n")).toEqual(["prod"]);
  });
});

// ─────────────────────────────────────────────────────────────────
// cfSpaces
// ─────────────────────────────────────────────────────────────────

describe("cfSpaces", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls 'cf spaces' and returns parsed space names", async () => {
    resolveExecFile(CF_SPACES_STDOUT);

    const result = await cfSpaces();

    expect(result).toEqual(["app", "dev"]);
    expect(mockExecFile).toHaveBeenCalledWith(
      "cf",
      ["spaces"],
      expect.any(Function),
    );
  });

  it("propagates cf command error", async () => {
    rejectExecFile("Permission denied");

    await expect(cfSpaces()).rejects.toThrow("Permission denied");
  });
});
