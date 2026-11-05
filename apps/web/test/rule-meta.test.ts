import { describe, expect, test } from "vitest";
import { toAction, toDraft } from "../app/(app)/automations/rule-meta";

describe("owner assignment editor conversion", () => {
  test.each([
    { type: "assign_owner", userId: "a" },
    { type: "assign_owner", strategy: "round_robin", userIds: ["a", "b"] },
    {
      type: "assign_owner",
      strategy: "territory",
      territories: [{ countries: ["DE"], userId: "a" }],
    },
    {
      type: "assign_owner",
      strategy: "territory",
      territories: [{ regions: ["bavaria"], userId: "b" }],
      fallbackUserId: "a",
    },
  ])("round trips $strategy", (action) => {
    expect(toAction(toDraft(action))).toEqual(action);
  });

  test("drops a blank territory row", () => {
    expect(
      toAction({
        type: "assign_territory",
        v: {
          territories: JSON.stringify([
            { countries: [], regions: [], userId: "" },
            { countries: ["DE"], userId: "a" },
          ]),
          fallbackUserId: "",
        },
      }),
    ).toEqual({
      type: "assign_owner",
      strategy: "territory",
      territories: [{ countries: ["DE"], userId: "a" }],
    });
  });

  test("passes an unknown action through raw", () => {
    const action = { type: "future_action", option: "x" };
    expect(toAction(toDraft(action))).toEqual(action);
  });
});
