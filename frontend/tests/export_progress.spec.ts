import { expect, test, type Page } from "@playwright/test";

const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+tmdoAAAAASUVORK5CYII=";
const layers = [
  { path: "0", name: "character", kind: "group", visible: true, effective_visible: true, bbox: [0, 0, 64, 64] },
  { path: "0/0", name: "face", kind: "pixel", visible: true, effective_visible: true, bbox: [0, 0, 64, 64] },
];

async function setup(page: Page) {
  await page.route("**/api/psd", (route) => route.fulfill({
    json: { width: 64, height: 64, fingerprint: "snapshot", preview: png, layers },
  }));
  await page.route("**/api/preset-preview", (route) =>
    route.fulfill({ json: { preview: png } }));
  await page.route("**/api/health", (route) => route.fulfill({
    json: { ok: true, default_output_dir: "/tmp/output" },
  }));
  await page.route("**/api/wav", (route) => route.fulfill({
    json: { samples: 800, sample_rate: 8000, duration_seconds: .1,
      source_identity: "1:2:3:4:5" },
  }));
  await page.route("**/api/preset-utterance-destination", (route) =>
    route.fulfill({ json: { state: "available", suggested_basename: "new" } }));
  await page.route("**/api/preset-batch-check-names", (route) =>
    route.fulfill({ json: { valid: true } }));
  await page.route("**/api/preset-batch-mov-destination", (route) =>
    route.fulfill({ json: { state: "available", canonical_output_dir: "/tmp/output" } }));
  await page.route("**/api/preset-combined-otio-destination", (route) =>
    route.fulfill({ json: { state: "available", canonical_output_dir: "/tmp/output" } }));
  await page.route("**/api/preset-batch-cancel", (route) =>
    route.fulfill({ json: { released: true } }));
  await page.goto("/");
  await page.locator("#preset-psd-path-advanced").evaluate((node) => {
    (node as HTMLDetailsElement).open = true;
  });
  await page.locator("#preset-psd-path").fill("/tmp/char.psd");
  await page.getByRole("button", { name: "読み込む", exact: true }).click();
  await page.getByRole("button", { name: "セリフ", exact: true }).click();
}

async function addWav(page: Page, name: string) {
  await page.locator("#speech-wav-path-advanced").evaluate((node) => {
    (node as HTMLDetailsElement).open = true;
  });
  await page.locator("#speech-wav-path").fill("/tmp/" + name);
  await page.getByRole("button", { name: "WAVを確認" }).click();
}

test("solo modal shows actual server progress and awaits worker cancellation", async ({ page }) => {
  await setup(page);
  await addWav(page, "あんこもん.wav");
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  let token = "";
  let cancelled = false;
  let requests = 0;
  await page.route("**/api/export-progress/*", (route) => route.fulfill({
    json: {
      status: cancelled ? "cancelling" : "running",
      stage: cancelled ? "キャンセル処理中" : "映像フレームをFFmpegへ送信中",
      percent: 42, index: 1, total: 1, frames: 84, frame_total: 200,
      can_cancel: !cancelled,
    },
  }));
  await page.route("**/api/export-cancel", (route) => {
    expect((route.request().postDataJSON() as { token: string }).token).toBe(token);
    cancelled = true;
    return route.fulfill({ json: { accepted: true, status: "cancelling" } });
  });
  await page.route("**/api/preset-utterance-export", async (route) => {
    requests++;
    token = (route.request().postDataJSON() as { progress_id: string }).progress_id;
    expect(token).toMatch(/^[0-9a-f-]{36}$/);
    await hold;
    await route.fulfill({ status: 409,
      json: { detail: "書き出しをキャンセルしました" } });
  });
  await page.getByRole("button", { name: "MOVを書き出す" }).click();
  const dialog = page.getByRole("dialog", { name: "書き出し中" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "42");
  await expect(dialog).toContainText("84 / 200");
  await expect(dialog).toContainText("あんこもん.wav");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "書き出しをキャンセル" }).click();
  await expect(page.getByRole("dialog")).toContainText("キャンセル処理中");
  await expect(page.getByRole("button", { name: "編集画面に戻る" })).toHaveCount(0);
  release(); // Only the server's completed response confirms cancellation.
  await expect(page.getByRole("dialog")).toContainText("書き出しをキャンセルしました");
  await page.getByRole("button", { name: "編集画面に戻る" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(requests).toBe(1);
});

test("batch cancellation never publishes OTIO or advances to the next WAV", async ({ page }) => {
  await setup(page);
  await addWav(page, "一件目.wav");
  await addWav(page, "二件目.wav");
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  let cancelled = false;
  let renders = 0;
  let otio = 0;
  await page.route("**/api/preset-batch-start", (route) =>
    route.fulfill({ json: { batch_id: "batch-session-token-long-enough" } }));
  await page.route("**/api/export-progress/*", (route) => route.fulfill({
    json: {
      status: cancelled ? "cancelling" : "running",
      stage: cancelled ? "キャンセル処理中" : "ProResを生成中",
      percent: 27, index: 1, total: 2, frames: 30, frame_total: 100,
      can_cancel: !cancelled,
    },
  }));
  await page.route("**/api/export-cancel", (route) => {
    expect((route.request().postDataJSON() as { token: string }).token)
      .toBe("batch-session-token-long-enough");
    cancelled = true;
    return route.fulfill({ json: { accepted: true, status: "cancelling" } });
  });
  await page.route("**/api/preset-batch-mov-export", async (route) => {
    renders++;
    await hold;
    await route.fulfill({ status: 409,
      json: { detail: "書き出しをキャンセルしました" } });
  });
  await page.route("**/api/preset-combined-otio", (route) => {
    otio++;
    return route.fulfill({ status: 500, json: { detail: "unexpected" } });
  });
  await page.getByRole("radio", { name: /全件/ }).check();
  await expect(page.getByText("書き出し予定を確認済み", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "全件を書き出す" }).click();
  await expect(page.getByRole("dialog")).toContainText("一件目.wav");
  await expect(page.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "27");
  await page.getByRole("button", { name: "書き出しをキャンセル" }).click();
  await expect(page.getByRole("dialog")).toContainText("キャンセル処理中");
  release();
  await expect(page.getByRole("dialog")).toContainText("書き出しをキャンセルしました");
  expect(renders).toBe(1);
  expect(otio).toBe(0);
});
