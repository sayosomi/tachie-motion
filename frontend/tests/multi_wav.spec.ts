import { expect, test, type Page } from "@playwright/test";

const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+tmdoAAAAASUVORK5CYII=";
const layers = [
  { path: "0", name: "face", kind: "group", visible: true, effective_visible: true, bbox: [0, 0, 64, 64] },
  { path: "0/0", name: "mouth", kind: "pixel", visible: true, effective_visible: true, bbox: [2, 2, 8, 8] },
];

async function openSpeech(page: Page) {
  await page.route("**/api/psd", (route) => route.fulfill({
    json: { width: 64, height: 64, fingerprint: "snapshot", preview: png, layers },
  }));
  await page.route("**/api/preset-preview", (route) =>
    route.fulfill({ json: { preview: png } }));
  await page.route("**/api/health", (route) =>
    route.fulfill({ json: { ok: true, default_output_dir: "/tmp/output" } }));
  await page.route("**/api/preset-utterance-destination", (route) =>
    route.fulfill({ json: { state: "available", suggested_basename: "alternate_002" } }));
  await page.goto("/");
  await page.locator("#preset-psd-path-advanced").evaluate(
    (el) => { (el as HTMLDetailsElement).open = true; });
  await page.locator("#preset-psd-path").fill("/tmp/character.psd");
  await page.getByRole("button", { name: "読み込む", exact: true }).click();
  await expect(page.getByRole("button", { name: "詳細を編集" })).toBeVisible();
  await page.getByRole("button", { name: "セリフ", exact: true }).click();
  await expect(page.locator("#speech-wav-path")).toBeAttached();
}

async function addWav(page: Page, path: string) {
  await page.locator("#speech-wav-path-advanced").evaluate(
    (el) => { (el as HTMLDetailsElement).open = true; });
  await page.locator("#speech-wav-path").fill(path);
  await page.getByRole("button", { name: "WAVを確認" }).click();
}

test("per-WAV editing survives reorder, duplicate registration and screen switching", async ({ page }) => {
  await page.route("**/api/wav", (route) => route.fulfill({
    json: { samples: 2000, sample_rate: 1000, duration_seconds: 2 },
  }));
  await openSpeech(page);

  const first = "/Volumes/A/あんこもん だんもん.wav";
  const sameNameElsewhere = "/Volumes/B/あんこもん だんもん.wav";
  await addWav(page, first);
  await expect(page.locator("[data-utterance-id]")).toHaveCount(1);
  await page.locator("#speech-lip-mode").selectOption("open");
  await page.locator("#speech-basename").fill("first_line");
  await addWav(page, sameNameElsewhere);
  await expect(page.locator("[data-utterance-id]")).toHaveCount(2);
  await page.locator("#speech-fps").selectOption("60");
  await page.locator("#speech-basename").fill("second_line");
  const registeredIds = await page.locator("[data-utterance-id]").evaluateAll(
    (nodes) => nodes.map((el) => el.getAttribute("data-utterance-id")));
  expect(new Set(registeredIds).size).toBe(2);
  await page.getByRole("button", { name: "上へ: 2 あんこもん だんもん.wav" }).click();
  await expect(page.locator("[data-utterance-id]").first()).toHaveAttribute(
    "data-utterance-id", registeredIds[1]);

  await page.locator("[data-utterance-id]").nth(1).locator(".utterance-item-select").click();
  await expect(page.locator("#speech-lip-mode")).toHaveValue("open");
  await expect(page.locator("#speech-basename")).toHaveValue("first_line");
  await expect(page.locator("#speech-fps")).toHaveValue("30");
  await page.locator("[data-utterance-id]").first().locator(".utterance-item-select").click();
  await expect(page.locator("#speech-lip-mode")).toHaveValue("none");
  await expect(page.locator("#speech-basename")).toHaveValue("second_line");
  await expect(page.locator("#speech-fps")).toHaveValue("60");

  await page.getByRole("button", { name: "プリセット", exact: true }).click();
  await page.getByRole("button", { name: "セリフ", exact: true }).click();
  await expect(page.locator("[data-utterance-id]")).toHaveCount(2);
  await expect(page.locator("#speech-basename")).toHaveValue("second_line");
  await page.getByRole("button", { name: "削除: 2 あんこもん だんもん.wav" }).click();
  await expect(page.locator("[data-utterance-id]")).toHaveCount(1);
  await expect(page.locator("[data-utterance-id]").first()).toHaveAttribute(
    "data-utterance-id", registeredIds[1]);
  await expect(page.locator("#speech-basename")).toHaveValue("second_line");
  await expect(page.locator("[data-utterance-id]").first().locator("small").first()).toHaveText(sameNameElsewhere);
});

test("out-of-order WAV inspection cannot select the wrong item or reorder registrations", async ({ page }) => {
  let releaseSlow: (() => void) | undefined;
  await page.route("**/api/wav", async (route) => {
    const { path } = route.request().postDataJSON() as { path: string };
    if (path.endsWith("slow.wav")) {
      await new Promise<void>((resolve) => { releaseSlow = resolve; });
    }
    await route.fulfill({ json: {
      samples: 1000, sample_rate: 1000, duration_seconds: 1,
    } });
  });
  await openSpeech(page);
  const slow = page.waitForRequest("**/api/wav");
  await addWav(page, "/tmp/slow.wav");
  await slow;
  const fast = page.waitForRequest("**/api/wav");
  await addWav(page, "/tmp/fast.wav");
  await fast;
  await expect(page.locator("[data-utterance-id]")).toHaveCount(1);
  await expect(page.locator(".utterance-item-select[aria-current=true]")).toContainText("fast.wav");
  expect(releaseSlow).toBeDefined();
  releaseSlow!();
  await expect(page.locator("[data-utterance-id]")).toHaveCount(2);
  await expect(page.locator("[data-utterance-id]").first()).toContainText("slow.wav");
  await expect(page.locator("[data-utterance-id]").nth(1)).toContainText("fast.wav");
  await expect(page.locator(".utterance-item-select[aria-current=true]")).toContainText("fast.wav");
});

test("failed addition preserves selected export and the PCM MOV endpoint receives that WAV once", async ({ page }) => {
  const path = "/tmp/voice 日本語.wav";
  const exports: Array<Record<string, unknown>> = [];
  await page.route("**/api/wav", (route) => {
    const payload = route.request().postDataJSON() as { path: string };
    if (payload.path.includes("missing")) {
      return route.fulfill({ status: 422, json: { detail: "WAVが見つかりません" } });
    }
    return route.fulfill({ json: { samples: 1000, sample_rate: 1000, duration_seconds: 1 } });
  });
  await page.route("**/api/preset-utterance-export", (route) => {
    exports.push(route.request().postDataJSON() as Record<string, unknown>);
    return route.fulfill({ json: {
      mov: "/tmp/output/speech_001.mov", otio: "/tmp/output/speech_001.otio",
      frames: 30, sample_count: 1000,
    } });
  });
  await openSpeech(page);
  await addWav(page, path);
  await expect(page.locator("[data-utterance-id]")).toHaveCount(1);
  await addWav(page, "/tmp/missing.wav");
  await expect(page.getByRole("alert").filter({ hasText: "WAVが見つかりません" })).toBeVisible();
  await expect(page.locator("[data-utterance-id]")).toHaveCount(1);
  await expect(page.locator("[data-utterance-id]").first().locator("small").first()).toHaveText(path);
  await expect(page.getByRole("button", { name: "MOVとOTIOを書き出す" })).toBeEnabled();
  await page.getByRole("button", { name: "MOVとOTIOを書き出す" }).click();
  await expect(page.getByText("書き出し完了・30フレーム")).toBeVisible();
  expect(exports).toHaveLength(1);
  expect(exports[0].wav).toBe(path);
  expect(exports[0].mode).toBe("none");
  expect(exports[0].basename).toBe("speech_001");
  expect(exports[0].conflict_policy).toBe("error");
});
