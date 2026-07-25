import { describe, expect, it } from "vitest";

import { buildCandidateList } from "../../src/tunnel/candidates.js";

function appsTable(rows: readonly { readonly name: string; readonly state: string }[]): string {
  const header = "name          requested state";
  const lines = rows.map((row) => `${row.name}   ${row.state}`);
  return [header, ...lines].join("\n");
}

describe("buildCandidateList", () => {
  it("always puts the target app first", () => {
    const stdout = appsTable([{ name: "sibling-a", state: "started" }]);
    expect(buildCandidateList("target-app", stdout, 3)).toEqual(["target-app", "sibling-a"]);
  });

  it("returns only the target app when discovery output is unavailable", () => {
    expect(buildCandidateList("target-app", undefined, 3)).toEqual(["target-app"]);
  });

  it("returns only the target app when discovery output has no recognizable rows", () => {
    expect(buildCandidateList("target-app", "No apps found\n", 3)).toEqual(["target-app"]);
  });

  it("excludes the target app itself from the discovered portion", () => {
    const stdout = appsTable([
      { name: "target-app", state: "started" },
      { name: "sibling-a", state: "started" },
    ]);
    expect(buildCandidateList("target-app", stdout, 3)).toEqual(["target-app", "sibling-a"]);
  });

  it("filters out apps that are not in a started state", () => {
    const stdout = appsTable([
      { name: "sibling-a", state: "started" },
      { name: "sibling-b", state: "stopped" },
    ]);
    expect(buildCandidateList("target-app", stdout, 3)).toEqual(["target-app", "sibling-a"]);
  });

  it("caps the discovered portion at maxCandidates, preserving discovery order", () => {
    const stdout = appsTable([
      { name: "sibling-a", state: "started" },
      { name: "sibling-b", state: "started" },
      { name: "sibling-c", state: "started" },
      { name: "sibling-d", state: "started" },
    ]);
    expect(buildCandidateList("target-app", stdout, 2)).toEqual([
      "target-app",
      "sibling-a",
      "sibling-b",
    ]);
  });

  it("dedupes repeated discovered app names", () => {
    const stdout = appsTable([
      { name: "sibling-a", state: "started" },
      { name: "sibling-a", state: "started" },
    ]);
    expect(buildCandidateList("target-app", stdout, 3)).toEqual(["target-app", "sibling-a"]);
  });

  it("skips a discovered app name shaped like a CLI flag", () => {
    const stdout = appsTable([
      { name: "-rf", state: "started" },
      { name: "sibling-a", state: "started" },
    ]);
    expect(buildCandidateList("target-app", stdout, 3)).toEqual(["target-app", "sibling-a"]);
  });

  it("skips a discovered app name containing disallowed characters", () => {
    const stdout = appsTable([
      { name: "sibling;rm", state: "started" },
      { name: "sibling-a", state: "started" },
    ]);
    expect(buildCandidateList("target-app", stdout, 3)).toEqual(["target-app", "sibling-a"]);
  });
});
