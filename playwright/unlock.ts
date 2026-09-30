import type { Page } from "@playwright/test";

/**
 * Unlocks editing the way a person does: the rail's Unlock editing button,
 * then the in-page token modal. It used to be window.prompt, answered with
 * page.once("dialog"); that is gone because some WebMCP hosts (ChatGPT
 * desktop) don't implement prompt() at all.
 */
export async function unlockWith(page: Page, token: string): Promise<void> {
  await page.locator("#ops-btn").click();
  await page.getByLabel("Ops token").fill(token);
  // Scoped to the dialog, and exact: "Unlock" is a substring of the rail's "Unlock editing".
  await page.locator("#unlock-dialog").getByRole("button", { name: "Unlock", exact: true }).click();
}
