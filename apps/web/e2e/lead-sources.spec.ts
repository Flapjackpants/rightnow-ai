import { expect, test } from "@playwright/test";
import { ensureSession, STATE } from "./session";

test.use({ storageState: STATE });
test.setTimeout(180_000);
test.beforeAll(async ({ playwright, baseURL }) => ensureSession(playwright, baseURL!));

test("save Apollo key and manage a search", async ({ page, request, baseURL }) => {
  const name = `E2E Apollo ${Date.now()}`;
  const listResponse = await request.post("/api/v1/lead-lists", {
    data: { name },
    headers: { origin: baseURL! },
  });
  expect(listResponse.ok()).toBe(true);
  await page.goto("/settings/lead-sources");
  await page.locator("#apollo-key").fill("fake-e2e-apollo-key");
  await page.getByRole("button", { name: "Save key" }).click();
  await expect(page.getByText("Key saved")).toBeVisible();
  await page.getByLabel("Name").fill(name);
  await page.getByLabel("Job titles").fill("CTO");
  await page.getByLabel("List", { exact: true }).selectOption({ label: name });
  await page
    .getByLabel("I have the right to contact these people and have checked Apollo's terms")
    .check();
  await page.getByRole("button", { name: "Create search" }).click();
  const row = page.getByRole("listitem").filter({ hasText: name });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Pause" }).click();
  await expect(row.getByText("Paused")).toBeVisible();
  await row.getByRole("button", { name: "Delete", exact: true }).click();
  await row.getByRole("button", { name: "Confirm delete" }).click();
  await expect(row).toHaveCount(0);
});
