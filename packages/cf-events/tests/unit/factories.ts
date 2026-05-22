import type { AuditEvent } from "../../src/types.js";

export function makeEvent(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    guid: "guid-1",
    type: "audit.app.start",
    createdAt: "2026-05-22T10:00:00.000Z",
    updatedAt: "2026-05-22T10:00:00.000Z",
    actor: { guid: "actor-1", type: "user", name: "user@example.com" },
    target: { guid: "target-1", type: "app", name: "orders-srv" },
    data: {},
    spaceGuid: undefined,
    organizationGuid: undefined,
    ...overrides,
  };
}
