import type { Page } from "@playwright/test";

/** Open a character's existing PSD groups for mouth-shape authoring. */
export async function openMotion(page: Page) {
  await page.getByRole("group", { name: "編集区分" })
    .getByRole("button", { name: "動かすパーツ" }).click();
}

export async function selectMouthGroup(page: Page, name: string, path: string) {
  await page.getByRole("button", { name: "変更" }).click();
  await page.getByRole("group", { name: "PSDグループ" })
    .getByRole("checkbox", { name: name + " [" + path + "]" }).check();
  await page.getByRole("button", { name: "閉じる", exact: true }).click();
}

/** First group is the standard test fixture's single face group. */
export async function assignOpenPair(page: Page,
  closedPath = "0/0", openedPath = "0/1", groupName = "face") {
  await openMotion(page);
  await selectMouthGroup(page, groupName, "0");
  await page.getByRole("group", { name: "編集する口形" })
    .getByRole("button", { name: "開き口" }).click();
  await page.locator(`.preset-layer[data-layer-path="${closedPath}"]`)
    .getByRole("checkbox").uncheck();
  await page.locator(`.preset-layer[data-layer-path="${openedPath}"]`)
    .getByRole("checkbox").check();
}
