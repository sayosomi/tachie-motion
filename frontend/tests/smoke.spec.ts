import { test, expect } from "@playwright/test";

const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+tmdoAAAAASUVORK5CYII=";
const layers = [
  { path: "0", name: "face", kind: "group", visible: true, effective_visible: true, bbox: [0,0,64,64] },
  { path: "0/0", name: "mouth-closed", kind: "pixel", visible: true, effective_visible: true, bbox: [3,3,9,9] },
  { path: "0/1", name: "mouth-open", kind: "pixel", visible: false, effective_visible: false, bbox: [3,3,9,9] },
];

async function mockPsd(page: import("@playwright/test").Page, fingerprint = "snap") {
  await page.route("**/api/psd", (route) => route.fulfill({ json: {
    width: 64, height: 64, fingerprint, preview: png, layers,
  }}));
  await page.route("**/api/preset-preview", (route) =>
    route.fulfill({ json: { preview: png } }));
  await page.route("**/api/health", (route) =>
    route.fulfill({ json: { ok: true, default_output_dir: "/tmp" } }));
  await page.route("**/api/wav", (route) => route.fulfill({ json: {
    samples: 1000, sample_rate: 1000, duration_seconds: 1,
  }}));
  await page.route("**/api/preset-utterance-destination", (route) =>
    route.fulfill({ json: { state: "available", suggested_basename: "speech_001" } }));
}

test("new preset-backed none/open utterance workflow sends exact preset snapshot", async ({ page }) => {
  await mockPsd(page);
  const payloads: Record<string, unknown>[] = [];
  await page.route("**/api/preset-utterance-export", (route) => {
    payloads.push(route.request().postDataJSON());
    return route.fulfill({ json: {
      mov: "/tmp/speech_001.mov", otio: "/tmp/speech_001.otio",
      frames: 30, sample_count: 1000,
    } });
  });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "動画書き出し（試験版）" })).toHaveCount(0);
  await page.locator("#preset-psd-path-advanced").evaluate((el) => { (el as HTMLDetailsElement).open = true; });
  await page.locator("#preset-psd-path").fill("/tmp/character.psd");
  await page.getByRole("button", { name: "読み込む", exact: true }).click();
  await page.getByRole("button", { name: "詳細を編集" }).click();
  const closedRole = page.locator('.preset-layer-role[data-layer-path="0/0"]');
  const openRole = page.locator('.preset-layer-role[data-layer-path="0/1"]');
  await closedRole.getByRole("button", { name: "Open: 閉じ口" }).click();
  await openRole.getByRole("button", { name: "Open: 開き口" }).click();
  await expect(closedRole).toHaveAttribute("data-open-role", "closed");
  await expect(openRole).toHaveAttribute("data-open-role", "opened");
  await page.getByRole("button", { name: "← 一覧へ" }).click();
  await page.getByRole("button", { name: "セリフ", exact: true }).click();
  await expect(page.getByRole("heading", { name: "セリフ" })).toBeVisible();
  await expect(page.getByText("PSD: /tmp/character.psd")).toBeVisible();
  await page.locator("#speech-wav-path-advanced").evaluate((el) => { (el as HTMLDetailsElement).open = true; });
  await page.locator("#speech-wav-path").fill("/tmp/voice.wav");
  await page.getByRole("button", { name: "WAVを確認" }).click();
  await expect(page.getByText("長さ 1.00秒")).toBeVisible();
  await page.locator("#speech-lip-mode").selectOption("open");
  await page.getByRole("button", { name: "MOVとOTIOを書き出す" }).click();
  await expect(page.getByRole("status")).toContainText("書き出し完了");
  expect(payloads).toHaveLength(1);
  expect(payloads[0]).toMatchObject({
    psd: "/tmp/character.psd", wav: "/tmp/voice.wav",
    fingerprint: "snap", mode: "open", blink_enabled: false,
    output_dir: "/tmp", basename: "speech_001", conflict_policy: "error", fps: 30,
    mouth: {
      closed: [{ path: "0/0", visible: true }, { path: "0/1", visible: false }],
      opened: [{ path: "0/0", visible: false }, { path: "0/1", visible: true }],
    },
  });
  await page.locator("#speech-lip-mode").selectOption("none");
  await expect(page.getByRole("status")).toHaveCount(0);
  await page.getByRole("button", { name: "MOVとOTIOを書き出す" }).click();
  expect(payloads[1]).toMatchObject({ mode: "none" });
});

test("stale PSD and missing mouth mappings block export", async ({ page }) => {
  await mockPsd(page);
  await page.goto("/");
  await page.locator("#preset-psd-path-advanced").evaluate((el) => { (el as HTMLDetailsElement).open = true; });
  await page.locator("#preset-psd-path").fill("/tmp/character.psd");
  await page.getByRole("button", { name: "読み込む", exact: true }).click();
  await page.getByRole("button", { name: "セリフ", exact: true }).click();
  await page.locator("#speech-wav-path-advanced").evaluate((el) => { (el as HTMLDetailsElement).open = true; });
  await page.locator("#speech-wav-path").fill("/tmp/voice.wav");
  await page.getByRole("button", { name: "WAVを確認" }).click();
  await page.locator("#speech-lip-mode").selectOption("open");
  await expect(page.getByRole("button", { name: "MOVとOTIOを書き出す" })).toBeDisabled();
  await expect(page.getByText("異なる閉口・開口")).toBeVisible();

  await page.route("**/api/psd", (route) => route.fulfill({ json: {
    width: 64, height: 64, fingerprint: "source-changed", preview: png, layers,
  }}));
  await page.reload();
  await page.getByRole("button", { name: "セリフ", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("PSDが変更");
  await expect(page.getByRole("button", { name: "MOVとOTIOを書き出す" })).toBeDisabled();
});


test("existing MOV and OTIO offer overwrite by default and an editable separate filename", async ({ page }) => {
  await mockPsd(page);
  const requests: Record<string, unknown>[] = [];
  let existing = true;
  await page.route("**/api/preset-utterance-destination", (route) => {
    return route.fulfill({ json: existing ? {
      state: "complete", suggested_basename: "speech_001_002",
    } : { state: "available", suggested_basename: "speech_001" } });
  });
  await page.route("**/api/preset-utterance-export", (route) => {
    requests.push(route.request().postDataJSON());
    return route.fulfill({ json: {
      mov: "/tmp/" + (requests.at(-1)?.basename as string) + ".mov",
      otio: "/tmp/" + (requests.at(-1)?.basename as string) + ".otio",
      frames: 30, sample_count: 1000,
      warning: requests.length === 1 ? "temporary render files could not be removed" : undefined,
    } });
  });
  await page.goto("/");
  await page.locator("#preset-psd-path-advanced").evaluate(el =>
    { (el as HTMLDetailsElement).open = true; });
  await page.locator("#preset-psd-path").fill("/tmp/character.psd");
  await page.getByRole("button", { name: "読み込む", exact: true }).click();
  await page.getByRole("button", { name: "セリフ", exact: true }).click();
  await page.locator("#speech-wav-path-advanced").evaluate(el =>
    { (el as HTMLDetailsElement).open = true; });
  await page.locator("#speech-wav-path").fill("/tmp/voice.wav");
  await page.getByRole("button", { name: "WAVを確認" }).click();
  await expect(page.getByText("同名のMOV・OTIOがあります")).toBeVisible();
  await expect(page.getByRole("radio", { name: "上書きする" })).toBeChecked();
  await page.getByRole("button", { name: "上書きして書き出す" }).click();
  await expect(page.getByRole("status")).toContainText("書き出し完了");
  await expect(page.getByRole("alert")).toContainText("temporary render files");
  expect(requests[0]).toMatchObject({
    basename: "speech_001", conflict_policy: "overwrite",
  });
  await page.getByRole("radio", { name: "別名で書き出す" }).check();
  await expect(page.locator("#speech-save-as")).toHaveValue("speech_001_002");
  await page.locator("#speech-save-as").fill("speech_003");
  await expect(page.getByText("出力予定：speech_003.mov")).toBeVisible();
  await page.getByRole("button", { name: "別名で書き出す" }).click();
  await expect(page.getByRole("status")).toContainText("speech_003.mov");
  expect(requests[1]).toMatchObject({
    basename: "speech_003", conflict_policy: "error",
  });
  existing = false;
});

test("half-existing output forbids overwrite and requires a new name", async ({ page }) => {
  await mockPsd(page);
  const requests: Record<string, unknown>[] = [];
  await page.route("**/api/preset-utterance-destination", route =>
    route.fulfill({ json: {
      state: "partial", suggested_basename: "speech_001_002",
    } }));
  await page.route("**/api/preset-utterance-export", route => {
    requests.push(route.request().postDataJSON());
    return route.fulfill({ json: {
      mov: "/tmp/speech_001_002.mov", otio: "/tmp/speech_001_002.otio",
      frames: 30, sample_count: 1000,
    } });
  });
  await page.goto("/");
  await page.locator("#preset-psd-path-advanced").evaluate(el =>
    { (el as HTMLDetailsElement).open = true; });
  await page.locator("#preset-psd-path").fill("/tmp/character.psd");
  await page.getByRole("button", { name: "読み込む", exact: true }).click();
  await page.getByRole("button", { name: "セリフ", exact: true }).click();
  await page.locator("#speech-wav-path-advanced").evaluate(el =>
    { (el as HTMLDetailsElement).open = true; });
  await page.locator("#speech-wav-path").fill("/tmp/voice.wav");
  await page.getByRole("button", { name: "WAVを確認" }).click();
  await expect(page.getByText("片方だけがあります", { exact: false })).toBeVisible();
  await expect(page.getByRole("radio", { name: "上書きする" })).toHaveCount(0);
  await expect(page.locator("#speech-save-as")).toHaveValue("speech_001_002");
  await page.getByRole("button", { name: "別名で書き出す" }).click();
  expect(requests[0]).toMatchObject({
    basename: "speech_001_002", conflict_policy: "error",
  });
});


test("one WAV sends identical open-mouth render settings through single and all exports", async ({ page }) => {
  await mockPsd(page);
  const requests: Array<Record<string, unknown>> = [];
  await page.route("**/api/preset-utterance-export", (route) => {
    const request = route.request().postDataJSON() as Record<string, unknown>;
    requests.push(request);
    return route.fulfill({ json: {
      mov: "/tmp/" + request.basename + ".mov",
      otio: "/tmp/" + request.basename + ".otio", frames: 30, sample_count: 1000,
    } });
  });
  await page.goto("/");
  await page.locator("#preset-psd-path-advanced").evaluate(
    (el) => { (el as HTMLDetailsElement).open = true; });
  await page.locator("#preset-psd-path").fill("/tmp/character.psd");
  await page.getByRole("button", { name: "読み込む", exact: true }).click();
  await page.getByRole("button", { name: "詳細を編集" }).click();
  await page.locator('.preset-layer-role[data-layer-path="0/0"]')
    .getByRole("button", { name: "Open: 閉じ口" }).click();
  await page.locator('.preset-layer-role[data-layer-path="0/1"]')
    .getByRole("button", { name: "Open: 開き口" }).click();
  await page.getByRole("button", { name: "← 一覧へ" }).click();
  await page.getByRole("button", { name: "セリフ", exact: true }).click();

  for (const path of ["/tmp/first.wav", "/tmp/second.wav"]) {
    await page.locator("#speech-wav-path-advanced").evaluate(
      (el) => { (el as HTMLDetailsElement).open = true; });
    await page.locator("#speech-wav-path").fill(path);
    await page.getByRole("button", { name: "WAVを確認" }).click();
  }
  await expect(page.locator("[data-utterance-id]")).toHaveCount(2);
  await page.locator("[data-utterance-id]").first().locator(".utterance-item-select").click();
  await page.locator("#speech-lip-mode").selectOption("open");
  await expect(page.locator("[data-utterance-id]").nth(1)).toContainText("口パク: なし");
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", {
    name: "このプリセット・口パク方式を全件に適用",
  }).click();
  await expect(page.locator("[data-utterance-id]").nth(1)).toContainText("口パク: open");

  await page.getByRole("button", { name: "MOVとOTIOを書き出す" }).click();
  await expect(page.getByText("書き出し完了・30フレーム")).toBeVisible();
  await page.getByRole("radio", { name: /^全件/ }).check();
  await expect(page.getByText("口パク「なし」が", { exact: false })).toHaveCount(0);
  await page.getByRole("button", { name: "全件を書き出す" }).click();
  await expect(page.getByText("一括書き出し完了：成功 2 件／失敗 0 件", { exact: false }))
    .toBeVisible();

  expect(requests).toHaveLength(3);
  expect(requests.map((request) => request.wav)).toEqual([
    "/tmp/first.wav", "/tmp/first.wav", "/tmp/second.wav",
  ]);
  expect(requests[0]).toEqual(requests[1]);
  expect(requests[1].mode).toBe("open");
  expect(requests[2].mode).toBe("open");
  expect(requests[2].mouth).toEqual(requests[0].mouth);
  expect(requests[2].layers).toEqual(requests[0].layers);
});
