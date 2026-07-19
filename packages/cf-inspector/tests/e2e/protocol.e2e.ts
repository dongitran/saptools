import { expect, test } from "@playwright/test";

import {
  connectInspector,
  evaluateOnFrame,
  getPossibleBreakpoints,
  getScriptSource,
  listScripts,
  releaseObject,
  releaseObjectGroup,
  removeBreakpoint,
  resume,
  setBreakpointAtLocation,
  stepInto,
  stepOut,
  stepOver,
  waitForPause,
} from "../../src/index.js";
import type { InspectorSession, PauseEvent } from "../../src/index.js";

import { spawnFixture, STACK_FIXTURE_PATH } from "./helpers.js";

function findSourceLine(source: string, fragment: string): number {
  const lineNumber = source.split("\n").findIndex((line) => line.includes(fragment));
  if (lineNumber < 0) {
    throw new Error(`Could not find ${JSON.stringify(fragment)} in the runtime source`);
  }
  return lineNumber;
}

function topFrame(pause: PauseEvent): PauseEvent["callFrames"][number] {
  const frame = pause.callFrames[0];
  if (frame === undefined) {
    throw new Error("Debugger.paused did not include a call frame");
  }
  return frame;
}

async function bestEffortResume(session: InspectorSession): Promise<void> {
  try {
    await resume(session);
  } catch {
    // The target may already be running when cleanup begins.
  }
}

test("User can drive exact protocol breakpoints and stepping against a local Node target", async () => {
  const fixture = await spawnFixture({
    fixturePath: STACK_FIXTURE_PATH,
    readyText: "sample-stack ready",
  });
  const session = await connectInspector({ port: fixture.port });
  let breakpointId: string | undefined;

  try {
    const script = listScripts(session).find((candidate) => candidate.url.endsWith("/sample-stack.mjs"));
    if (script === undefined) {
      throw new Error("The local fixture script was not reported by Debugger.scriptParsed");
    }

    const source = await getScriptSource(session, script.scriptId);
    expect(source).toContain("function helper(payload)");
    expect(script.length).toBe(source.length);

    const abortController = new AbortController();
    const abortedWait = waitForPause(session, {
      timeoutMs: 10_000,
      signal: abortController.signal,
    });
    abortController.abort();
    await expect(abortedWait).rejects.toMatchObject({ code: "ABORTED" });
    expect(session.pauseWaitGate.active).toBe(false);
    await expect(getScriptSource(session, script.scriptId)).resolves.toBe(source);

    const statementLine = findSourceLine(source, "const wrapped = deeperHelper");
    const functionEndLine = findSourceLine(source, "function entry(payload)");
    const locations = await getPossibleBreakpoints(session, {
      start: { scriptId: script.scriptId, lineNumber: statementLine, columnNumber: 0 },
      end: { scriptId: script.scriptId, lineNumber: functionEndLine, columnNumber: 0 },
      restrictToFunction: true,
    });
    const location = locations.find((candidate) => candidate.lineNumber === statementLine);
    if (location === undefined) {
      throw new Error("The helper statement did not produce an exact break location");
    }

    const breakpoint = await setBreakpointAtLocation(session, { location });
    breakpointId = breakpoint.breakpointId;
    expect(breakpoint.actualLocation.scriptId).toBe(script.scriptId);

    const initialPause = await waitForPause(session, {
      timeoutMs: 10_000,
      breakpointIds: [breakpoint.breakpointId],
    });
    const initialFrame = topFrame(initialPause);
    expect(initialFrame.functionName).toBe("helper");
    expect(initialFrame.scriptId).toBe(script.scriptId);
    expect(initialFrame.thisObject?.type).toBeDefined();

    await removeBreakpoint(session, breakpoint.breakpointId);
    breakpointId = undefined;

    const owned = await evaluateOnFrame(
      session,
      initialFrame.callFrameId,
      "({ ownership: 'single-object' })",
      { objectGroup: "protocol-e2e" },
    );
    const ownedObjectId = owned.result?.objectId;
    if (typeof ownedObjectId !== "string") {
      throw new Error("Debugger.evaluateOnCallFrame did not create a remote object");
    }
    await releaseObject(session, ownedObjectId);

    const grouped = await evaluateOnFrame(
      session,
      initialFrame.callFrameId,
      "({ ownership: 'object-group' })",
      { objectGroup: "protocol-e2e" },
    );
    expect(typeof grouped.result?.objectId).toBe("string");
    await releaseObjectGroup(session, "protocol-e2e");

    await stepInto(session);
    const intoPause = await waitForPause(session, { timeoutMs: 10_000 });
    expect(topFrame(intoPause).functionName).toBe("deeperHelper");

    await stepOver(session);
    const overPause = await waitForPause(session, { timeoutMs: 10_000 });
    expect(topFrame(overPause).functionName).toBe("deeperHelper");

    await stepOut(session);
    const outPause = await waitForPause(session, { timeoutMs: 10_000 });
    expect(topFrame(outPause).functionName).toBe("helper");
  } finally {
    if (breakpointId !== undefined) {
      await removeBreakpoint(session, breakpointId).catch(() => undefined);
    }
    await bestEffortResume(session);
    await session.dispose();
    await fixture.close();
  }
});
