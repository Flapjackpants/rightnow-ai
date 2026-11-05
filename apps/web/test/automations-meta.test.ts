import { ACTIONS, TRIGGERS } from "@rightnow/core";
import { describe, expect, it } from "vitest";
import {
  ACTION_TYPES,
  TRIGGERS as CLIENT_TRIGGERS,
  toAction,
  toDraft,
} from "../app/(app)/automations/rule-meta";

describe("rule editor tables", () => {
  it("name exactly the triggers and actions the engine has", () => {
    expect(Object.keys(CLIENT_TRIGGERS).sort()).toEqual(Object.keys(TRIGGERS).sort());
    // two editor-only types that both save as assign_owner
    const uiOnly = ["assign_round_robin", "assign_territory"];
    expect(
      Object.keys(ACTION_TYPES)
        .filter((k) => !uiOnly.includes(k))
        .sort(),
    ).toEqual(Object.keys(ACTIONS).sort());
  });

  it("pick the webhook of send_webhook from the workspace's webhooks", () => {
    expect(ACTION_TYPES.send_webhook!.fields).toEqual([
      { key: "webhookId", label: "Webhook", kind: "select", source: "webhooks", required: true },
    ]);
  });

  it("pass an action type the client does not know through unchanged", () => {
    const hook = { type: "future_action", webhookId: "w1", extra: { a: 1 } };
    expect(toAction(toDraft(hook))).toEqual(hook);
    const task = { type: "create_task", title: "Call", dueInDays: 2 };
    expect(toAction(toDraft(task))).toEqual(task);
  });
});
