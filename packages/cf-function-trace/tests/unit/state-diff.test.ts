import { describe, expect, it } from "vitest";

import type { StatePatchOperation } from "../../src/contracts.js";
import { applyStatePatch, diffStates } from "../../src/state-diff.js";

describe("trace state diff", () => {
  it("creates deterministic add, remove, and replace operations that replay exactly", () => {
    const before = { count: 1, old: true, stable: { value: "same" } };
    const after = { count: 2, added: "new", stable: { value: "same" } };
    const patch = diffStates(before, after);
    expect(patch.operations).toEqual([
      { op: "add", path: "/added", value: "new" },
      { op: "replace", path: "/count", value: 2 },
      { op: "remove", path: "/old" },
    ]);
    expect(applyStatePatch(before, patch.operations)).toEqual(patch.after.value);
    expect(patch.changedPaths).toEqual(["/added", "/count", "/old"]);
  });

  it("keeps confirmed value changes granular inside incomplete captures", () => {
    const before = { value: { completeness: "truncated", properties: { visible: 1 } } };
    const after = { value: { completeness: "truncated", properties: { visible: 2 } } };
    expect(diffStates(before, after).operations).toEqual([
      { op: "replace", path: "/value/properties/visible", value: 2 },
    ]);
  });

  it("replaces the smallest incomplete record when ITS OWN key is removed", () => {
    const before = { node: { completeness: "truncated", extra: "gone" } };
    const after = { node: { completeness: "truncated" } };

    expect(diffStates(before, after).operations).toEqual([
      { op: "replace", path: "/node", value: after.node },
    ]);
  });

  it("replaces the enclosing node when a properties-bag key vanishes under it", () => {
    // `properties` never carries its own `completeness` field (only its
    // parent node does), so a removal inside it cannot be ruled on by
    // `properties` itself — the ambiguity must bubble up to the nearest
    // record that actually carries `completeness` (here, `value`) instead of
    // being reported as a confident, specific `remove` that may well still
    // exist on the live object and simply missed this capture's window.
    const before = { value: { completeness: "truncated", properties: { visible: 1, maybeOmitted: 2 } } };
    const after = { value: { completeness: "truncated", properties: { visible: 1 } } };

    expect(diffStates(before, after).operations).toEqual([
      { op: "replace", path: "/value", value: after.value },
    ]);
  });

  it("replaces the enclosing frame, not the whole CapturedState, when a root vanishes", () => {
    // Mirrors the real regression at the top level: top-level completeness is
    // "truncated" (the normal case for a real capture), but the frame is the
    // nearest record that actually carries completeness for its own `roots`
    // map. The ambiguity must stop there instead of propagating all the way
    // up and collapsing the entire captured state to one giant replace.
    const before = {
      version: 1,
      completeness: "truncated",
      frames: [{ completeness: "truncated", roots: { "scope.0.local.a": 1, "scope.0.local.b": 2 } }],
    };
    const after = {
      version: 1,
      completeness: "truncated",
      frames: [{ completeness: "truncated", roots: { "scope.0.local.a": 1 } }],
    };

    expect(diffStates(before, after).operations).toEqual([
      { op: "replace", path: "/frames/0", value: after.frames[0] },
    ]);
  });

  it("stays granular through a distant truncated ancestor when the direct parent is complete", () => {
    // The top-level state is truncated (typical for a real capture, e.g.
    // because of a DIFFERENT frame or an overall size cap), but the frame and
    // node directly enclosing the removed property are both fully captured.
    // Their own "complete" verdict is authoritative and must not be
    // second-guessed by an unrelated ancestor further up the tree — this is
    // what keeps everyday diffs granular instead of collapsing to the whole
    // captured state.
    const before = {
      completeness: "truncated",
      frames: [{ completeness: "complete", nodes: { n0: { completeness: "complete", properties: { a: 1, b: 2 } } } }],
    };
    const after = {
      completeness: "truncated",
      frames: [{ completeness: "complete", nodes: { n0: { completeness: "complete", properties: { a: 1 } } } }],
    };

    expect(diffStates(before, after).operations).toEqual([
      { op: "remove", path: "/frames/0/nodes/n0/properties/b" },
    ]);
  });

  it("escapes JSON Pointer keys and emits no operations for unchanged state", () => {
    const before = { "a/b~c": 1 };
    const patch = diffStates(before, { "a/b~c": 2 });

    expect(patch.operations).toEqual([{ op: "replace", path: "/a~1b~0c", value: 2 }]);
    expect(applyStatePatch(before, patch.operations)).toEqual(patch.after.value);
    expect(diffStates(before, before).operations).toEqual([]);
  });

  it("diffs stable array positions and replays inserted stack frames", () => {
    expect(diffStates([1, 2], [1, 3]).operations).toEqual([
      { op: "replace", path: "/1", value: 3 },
    ]);
    const before = { frames: [{ functionName: "root", value: 1 }] };
    const after = { frames: [{ functionName: "child", value: 2 }, ...before.frames] };
    const patch = diffStates(before, after);
    expect(patch.operations).toEqual([
      { op: "add", path: "/frames/0", value: after.frames[0] },
    ]);
    expect(applyStatePatch(before, patch.operations)).toEqual(patch.after.value);
    expect(applyStatePatch(1, [{ op: "replace", path: "", value: 2 }])).toBe(2);
  });

  it("reports variable paths instead of replacing a truncated frame timeline", () => {
    const before = {
      version: 1,
      frames: [{ completeness: "truncated", nodes: { n0: { properties: { count: 1 } } } }],
      completeness: "truncated",
    };
    const after = {
      version: 1,
      frames: [{ completeness: "truncated", nodes: { n0: { properties: { count: 2 } } } }],
      completeness: "truncated",
    };

    const patch = diffStates(before, after);
    expect(patch.changedPaths).toEqual(["/frames/0/nodes/n0/properties/count"]);
    expect(applyStatePatch(before, patch.operations)).toEqual(patch.after.value);
  });

  it("fails closed for malformed, unsafe, and invalid patch paths", () => {
    const invalidOperations: readonly (readonly StatePatchOperation[])[] = [
      [{ op: "replace", path: "missing-slash", value: 2 }],
      [{ op: "replace", path: "/bad~2escape", value: 2 }],
      [{ op: "replace", path: "/__proto__/polluted", value: true }],
      [{ op: "replace", path: "/missing/child", value: true }],
      [{ op: "remove", path: "/missing" }],
      [{ op: "remove", path: "" }],
    ];

    for (const operations of invalidOperations) {
      expect(() => applyStatePatch({ safe: true }, operations)).toThrowError(expect.objectContaining({
        code: "INVALID_ARTIFACT",
      }));
    }
  });

  it("requires replace operations to target an existing property", () => {
    expect(() => applyStatePatch({ safe: true }, [
      { op: "replace", path: "/missing", value: false },
    ])).toThrowError(expect.objectContaining({ code: "INVALID_ARTIFACT" }));
  });

  it("replays changes to records containing an own __proto__ key", () => {
    const before: unknown = JSON.parse('{"__proto__":{"value":1},"safe":true}');
    const after: unknown = JSON.parse('{"__proto__":{"value":2},"safe":true}');
    const patch = diffStates(before, after);

    expect(applyStatePatch(before, patch.operations)).toEqual(patch.after.value);
    expect(Object.hasOwn(Object.prototype, "value")).toBe(false);
  });
});
