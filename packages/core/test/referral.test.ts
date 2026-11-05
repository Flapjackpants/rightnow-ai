import type { ReplyCategory } from "@rightnow/db/client";
import { describe, expect, test } from "vitest";
import { extractReferrals } from "../src/mail/referral";

describe("extractReferrals", () => {
  const cases: Array<[string, string, string[], ReplyCategory | null, string[], boolean]> = [
    [
      "cc'ing colleague",
      "cc'ing my colleague Sam",
      ["sam@acme.test"],
      null,
      ["sam@acme.test"],
      false,
    ],
    [
      "wrong person address",
      "I left the company, please contact sam@acme.test",
      [],
      "WRONG_PERSON",
      ["sam@acme.test"],
      false,
    ],
    ["wrong person without address", "Wrong person", [], "WRONG_PERSON", [], true],
    ["other domain", "Please contact sam@other.test", [], "WRONG_PERSON", [], true],
    [
      "signature without phrase",
      `Interested.\n\n${"x".repeat(130)} amy@acme.test`,
      [],
      "INTERESTED",
      [],
      false,
    ],
    ["separate paragraph", "Please contact Sam.\n\n--\namy@acme.test", [], "INTERESTED", [], false],
    ["plain CC", "Thanks", ["sam@acme.test"], "INTERESTED", [], false],
    ["quoted address", "Please contact Sam\n> sam@acme.test", [], "INTERESTED", [], false],
    [
      "excluded addresses",
      "Please contact pat@acme.test me@acme.test sales@acme.test no-reply@acme.test",
      [],
      null,
      [],
      false,
    ],
    [
      "max three and dedupe",
      "Please contact a@acme.test b@acme.test c@acme.test d@acme.test a@acme.test",
      [],
      null,
      ["a@acme.test", "b@acme.test", "c@acme.test"],
      false,
    ],
  ];
  test.each(cases)("%s", (_name, text, cc, category, emails, needsTask) => {
    expect(
      extractReferrals({ text, cc, category, leadEmail: "pat@acme.test", own: ["me@acme.test"] }),
    ).toEqual({ emails, needsTask });
  });
  test("free-mail lead cannot refer a contact", () => {
    expect(
      extractReferrals({
        text: "Please contact sam@gmail.com",
        cc: [],
        category: "WRONG_PERSON",
        leadEmail: "pat@gmail.com",
        own: [],
      }),
    ).toEqual({ emails: [], needsTask: true });
  });
});
