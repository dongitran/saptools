/* eslint import/order: "off" -- eslint-plugin-import 2.32 crashes on this file with ESLint 10 */
import { describe, expect, it } from "vitest";

import type { CfStructure } from "../../src/types.js";
import {
  collectDbTargets,
  parseDbTargetSelector,
  resolveDbTargetSelector,
} from "../../src/db-targets.js";

function createStructure(): CfStructure {
  return {
    syncedAt: "2026-04-24T00:00:00.000Z",
    regions: [
      {
        key: "ap10",
        label: "Singapore",
        apiEndpoint: "https://api.cf.ap10.hana.ondemand.com",
        accessible: true,
        orgs: [
          {
            name: "org-alpha",
            spaces: [
              {
                name: "dev",
                apps: [{ name: "orders-srv" }, { name: "shared-srv" }],
              },
            ],
          },
        ],
      },
      {
        key: "eu10",
        label: "Frankfurt",
        apiEndpoint: "https://api.cf.eu10.hana.ondemand.com",
        accessible: true,
        orgs: [
          {
            name: "org-beta",
            spaces: [
              {
                name: "prod",
                apps: [{ name: "billing-srv" }, { name: "shared-srv" }],
              },
            ],
          },
        ],
      },
    ],
  };
}

describe("db-targets", () => {
  it("collects every app target from the topology snapshot", () => {
    expect(collectDbTargets(createStructure())).toEqual([
      {
        selector: "ap10/org-alpha/dev/orders-srv",
        regionKey: "ap10",
        apiEndpoint: "https://api.cf.ap10.hana.ondemand.com",
        orgName: "org-alpha",
        spaceName: "dev",
        appName: "orders-srv",
      },
      {
        selector: "ap10/org-alpha/dev/shared-srv",
        regionKey: "ap10",
        apiEndpoint: "https://api.cf.ap10.hana.ondemand.com",
        orgName: "org-alpha",
        spaceName: "dev",
        appName: "shared-srv",
      },
      {
        selector: "eu10/org-beta/prod/billing-srv",
        regionKey: "eu10",
        apiEndpoint: "https://api.cf.eu10.hana.ondemand.com",
        orgName: "org-beta",
        spaceName: "prod",
        appName: "billing-srv",
      },
      {
        selector: "eu10/org-beta/prod/shared-srv",
        regionKey: "eu10",
        apiEndpoint: "https://api.cf.eu10.hana.ondemand.com",
        orgName: "org-beta",
        spaceName: "prod",
        appName: "shared-srv",
      },
    ]);
  });

  it("parses an explicit region/org/space/app selector", () => {
    expect(parseDbTargetSelector("ap10/org-alpha/dev/orders-srv")).toEqual({
      type: "explicit",
      regionKey: "ap10",
      orgName: "org-alpha",
      spaceName: "dev",
      appName: "orders-srv",
      selector: "ap10/org-alpha/dev/orders-srv",
    });
  });

  it("trims each explicit selector segment", () => {
    expect(parseDbTargetSelector(" ap10 / org-alpha / dev / api-app ")).toEqual({
      type: "explicit",
      regionKey: "ap10",
      orgName: "org-alpha",
      spaceName: "dev",
      appName: "api-app",
      selector: "ap10/org-alpha/dev/api-app",
    });
  });

  it("resolves explicit selectors for scale-out sub-regions", () => {
    expect(resolveDbTargetSelector(createStructure(), "eu10-002/org-beta/prod/api-app")).toEqual([
      {
        selector: "eu10-002/org-beta/prod/api-app",
        regionKey: "eu10-002",
        apiEndpoint: "https://api.cf.eu10-002.hana.ondemand.com",
        orgName: "org-beta",
        spaceName: "prod",
        appName: "api-app",
      },
    ]);
  });

  it("collects no DB targets from an empty topology snapshot", () => {
    expect(
      collectDbTargets({
        syncedAt: "2026-04-24T00:00:00.000Z",
        regions: [],
      }),
    ).toEqual([]);
  });

  it("resolves a unique plain app name from topology", () => {
    expect(resolveDbTargetSelector(createStructure(), "billing-srv")).toEqual([
      {
        selector: "eu10/org-beta/prod/billing-srv",
        regionKey: "eu10",
        apiEndpoint: "https://api.cf.eu10.hana.ondemand.com",
        orgName: "org-beta",
        spaceName: "prod",
        appName: "billing-srv",
      },
    ]);
  });

  it("rejects ambiguous plain app names and lists the candidates", () => {
    expect(() => resolveDbTargetSelector(createStructure(), "shared-srv")).toThrow(
      /ap10\/org-alpha\/dev\/shared-srv.*eu10\/org-beta\/prod\/shared-srv/s,
    );
  });

  it("rejects an empty DB selector", () => {
    expect(() => parseDbTargetSelector("   ")).toThrow(/must not be empty/);
  });

  it("rejects malformed DB selectors", () => {
    expect(() => parseDbTargetSelector("ap10/org-alpha/orders-srv")).toThrow(
      /region\/org\/space\/app/,
    );
  });

  it("rejects DB selectors with too many segments", () => {
    expect(() => parseDbTargetSelector("ap10/org-alpha/dev/api-app/extra")).toThrow(
      /region\/org\/space\/app/,
    );
  });

  it("rejects explicit selectors with unknown region keys", () => {
    expect(() => parseDbTargetSelector("bogus/org-alpha/dev/orders-srv")).toThrow(/Unknown region key/);
  });

  it("rejects missing app names from topology", () => {
    expect(() => resolveDbTargetSelector(createStructure(), "missing-srv")).toThrow(/Could not find app/);
  });
});
