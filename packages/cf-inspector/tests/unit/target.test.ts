import type { SessionStatus } from "@saptools/cf-debugger";
import { describe, expect, it } from "vitest";

import { formatCfTunnelStatus } from "../../src/cli/target.js";

describe("Cloud Foundry tunnel progress", () => {
  it.each<readonly [SessionStatus, string]>([
    ["starting", "Preparing the Cloud Foundry debugger..."],
    ["logging-in", "Logging in to Cloud Foundry..."],
    ["targeting", "Targeting the Cloud Foundry org and space..."],
    ["ssh-enabling", "Enabling SSH for the Cloud Foundry app..."],
    ["ssh-restarting", "Restarting the Cloud Foundry app to activate SSH..."],
    ["signaling", "Starting the remote Node.js inspector..."],
    ["tunneling", "Opening the SSH inspector tunnel..."],
    ["ready", "Cloud Foundry inspector tunnel is ready."],
    ["stopping", "Closing the Cloud Foundry inspector tunnel..."],
    ["stopped", "Cloud Foundry inspector tunnel closed."],
    ["error", "Cloud Foundry inspector tunnel failed."],
  ])("maps %s without exposing raw status detail", (status, expected) => {
    expect(formatCfTunnelStatus(status)).toBe(expected);
  });
});
