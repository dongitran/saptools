import { describe, expect, it } from "vitest";

import {
  orgFolderName,
  parsePrefixedName,
  regionFolderName,
  spaceFolderName,
} from "../../src/collection/paths.js";

describe("folder name helpers", () => {
  it("builds region/org/space folder names", () => {
    expect(regionFolderName("ap10")).toBe("region__ap10");
    expect(orgFolderName("myorg")).toBe("org__myorg");
    expect(spaceFolderName("dev")).toBe("space__dev");
  });

  it("parses a prefixed dir name", () => {
    expect(parsePrefixedName("region__ap10", "region__")).toBe("ap10");
    expect(parsePrefixedName("irrelevant", "region__")).toBeUndefined();
  });
});
