import { expect, test } from "@playwright/test";

const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+tmdoAAAAASUVORK5CYII=";
const origin = "http://127.0.0.1:8765";
const layers = [
  { path: "0", name: "face", kind: "group", visible: true, effective_visible: true, bbox: [0,0,64,64] },
  { path: "0/0", name: "mouth", kind: "pixel", visible: true, effective_visible: true, bbox: [2,2,8,8] },
];

test("Finder-first picker selects PSD/WAV/output folder without direct path typing", async ({ page }) => {
  const picked: Array<{ kind: string; initial_dir?: string }> = [];
  await page.route("http://127.0.0.1:8766/health", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    headers: { "access-control-allow-origin": origin },
    body: JSON.stringify({ picker: "mac-local", ready: true }),
  }));
  await page.route("http://127.0.0.1:8766/pick", (route) => {
    if (route.request().method() === "OPTIONS") {
      return route.fulfill({ status: 204, headers: {
        "access-control-allow-origin": origin, "access-control-allow-methods": "POST",
        "access-control-allow-headers": "Content-Type, X-Tachie-Picker",
      } });
    }
    const { kind, initial_dir } = route.request().postDataJSON() as { kind: string; initial_dir?: string };
    picked.push(initial_dir ? { kind, initial_dir } : { kind });
    const path = { psd: "/Volumes/立ち絵素材/あんこもん だんもん.psd",
      wav: "/Volumes/合成音声/あんこもん だんもん.wav",
      output_dir: "/Users/testing/Movies" }[kind as "psd" | "wav" | "output_dir"];
    return route.fulfill({ status: 200, contentType: "application/json",
      headers: { "access-control-allow-origin": origin },
      body: JSON.stringify({ status: "selected", path }),
    });
  });
  const psdPaths: string[] = [];
  await page.route("**/api/psd", (route) => {
    psdPaths.push((route.request().postDataJSON() as { path: string }).path);
    return route.fulfill({ json: {
      width: 64, height: 64, fingerprint: "snap", preview: png, layers,
    } });
  });
  await page.route("**/api/preset-preview", (route) =>
    route.fulfill({ json: { preview: png } }));
  await page.route("**/api/wav", (route) => route.fulfill({ json: {
    samples: 1000, sample_rate: 1000, duration_seconds: 1,
  } }));
  await page.route("**/api/health", (route) =>
    route.fulfill({ json: { ok: true, default_output_dir: "/tmp" } }));

  await page.goto("/");
  await expect(page.getByRole("button", { name: "Finderで選ぶ" })).toBeEnabled();
  await expect(page.locator("#preset-psd-path-advanced")).not.toHaveAttribute("open");
  await page.getByRole("button", { name: "Finderで選ぶ" }).click();
  await expect(page.getByText("キャンバス 64 × 64 px")).toBeVisible();
  expect(psdPaths).toEqual(["/Volumes/立ち絵素材/あんこもん だんもん.psd"]);

  await page.getByRole("button", { name: "セリフ", exact: true }).click();
  await expect(page.getByRole("button", { name: "Finderで選ぶ" })).toBeEnabled();
  await page.getByRole("button", { name: "Finderで選ぶ" }).click();
  await expect(page.locator(".utterance-item").first()).toContainText("1.00秒 ／ 1000Hz");
  await page.getByRole("button", { name: "フォルダを選ぶ" }).click();
  await expect(page.getByText("Movies", { exact: true })).toBeVisible();
  expect(picked).toEqual([
    { kind: "psd" },
    { kind: "wav" },
    { kind: "output_dir" },
  ]);
  expect(await page.evaluate(() => localStorage.getItem("tachie-motion.picker-dir.v1.psd")))
    .toBe("/Volumes/立ち絵素材");
  expect(await page.evaluate(() => localStorage.getItem("tachie-motion.picker-dir.v1.wav")))
    .toBe("/Volumes/合成音声");
  expect(await page.evaluate(() => localStorage.getItem("tachie-motion.picker-dir.v1.output_dir")))
    .toBe("/Users/testing/Movies");

  await page.getByRole("button", { name: "Finderで選ぶ" }).click();
  expect(picked.at(-1)).toEqual({ kind: "wav", initial_dir: "/Volumes/合成音声" });
  await page.reload();
  await expect(page.getByRole("button", { name: "Finderで選ぶ" })).toBeEnabled();
  // Recovery has unsaved presets, so reselecting the same PSD asks before replacing.
  // Dismiss deliberately rather than leaving a browser dialog during teardown.
  await Promise.all([
    page.waitForEvent("dialog").then(async (dialog) => {
      expect(dialog.message()).toContain("保存済みのプリセットを破棄");
      await dialog.dismiss();
    }),
    page.getByRole("button", { name: "Finderで選ぶ" }).click(),
  ]);
  await expect(page.getByRole("button", { name: "詳細を編集" })).toBeVisible();
  expect(picked.at(-1)).toEqual({ kind: "psd", initial_dir: "/Volumes/立ち絵素材" });

});

test("cancelled Finder picker keeps original PSD edit state", async ({ page }) => {
  await page.route("http://127.0.0.1:8766/health", (route) => route.fulfill({
    status: 200, contentType: "application/json",
    headers: { "access-control-allow-origin": origin },
    body: JSON.stringify({ picker: "mac-local", ready: true }),
  }));
  await page.route("http://127.0.0.1:8766/pick", (route) => {
    if (route.request().method() === "OPTIONS") return route.fulfill({
      status: 204, headers: {
        "access-control-allow-origin": origin,
        "access-control-allow-methods": "POST",
        "access-control-allow-headers": "Content-Type, X-Tachie-Picker",
      },
    });
    return route.fulfill({ status: 200, contentType: "application/json",
      headers: { "access-control-allow-origin": origin },
      body: JSON.stringify({ status: "cancelled" }),
    });
  });
  await page.route("**/api/psd", (route) => route.fulfill({ json: {
    width: 64, height: 64, fingerprint: "snap", preview: png, layers,
  } }));
  await page.route("**/api/preset-preview", (route) =>
    route.fulfill({ json: { preview: png } }));

  await page.goto("/");
  await page.locator("#preset-psd-path-advanced").evaluate(
    (el) => { (el as HTMLDetailsElement).open = true; });
  await page.locator("#preset-psd-path").fill("/tmp/existing.psd");
  await page.getByRole("button", { name: "読み込む", exact: true }).click();
  await expect(page.getByRole("button", { name: "詳細を編集" })).toBeVisible();
  await page.getByRole("button", { name: "詳細を編集" }).click();
  await page.getByRole("checkbox", { name: "mouth [0/0] 表示" }).uncheck();
  await expect(page.getByRole("checkbox", { name: "mouth [0/0] 表示" })).not.toBeChecked();
  await page.getByRole("button", { name: "← 一覧へ" }).click();
  const originalDraft = await page.evaluate(() =>
    localStorage.getItem("tachie-motion.preset-draft.v1"));
  await page.getByRole("button", { name: "Finderで選ぶ" }).click();
  await expect(page.getByRole("button", { name: "詳細を編集" })).toBeVisible();
  await expect(page.locator("#preset-psd-path")).toHaveValue("/tmp/existing.psd");
  await expect(page.locator("[data-preset-id]")).toHaveCount(1);
  expect(await page.evaluate(() => localStorage.getItem("tachie-motion.preset-draft.v1")))
    .toBe(originalDraft);
  await page.getByRole("button", { name: "詳細を編集" }).click();
  await expect(page.getByRole("checkbox", { name: "mouth [0/0] 表示" })).not.toBeChecked();
});

test("Finder-selected replacement PSD rejected by confirm leaves original edit and path", async ({ page }) => {
  await page.route("http://127.0.0.1:8766/health", route => route.fulfill({
    json: { picker: "mac-local", ready: true },
    headers: { "access-control-allow-origin": origin },
  }));
  await page.route("http://127.0.0.1:8766/pick", route => {
    if (route.request().method() === "OPTIONS") return route.fulfill({
      status: 204, headers: {
        "access-control-allow-origin": origin,
        "access-control-allow-methods": "POST",
        "access-control-allow-headers": "Content-Type, X-Tachie-Picker",
      },
    });
    return route.fulfill({
      json: { status: "selected", path: "/Volumes/new-folder/other.psd" },
      headers: { "access-control-allow-origin": origin },
    });
  });
  const loaded: string[] = [];
  await page.route("**/api/psd", route => {
    loaded.push((route.request().postDataJSON() as { path: string }).path);
    return route.fulfill({ json: {
      width: 64, height: 64, fingerprint: "snapshot", preview: png, layers,
    } });
  });
  await page.route("**/api/preset-preview", route =>
    route.fulfill({ json: { preview: png } }));
  await page.goto("/");
  await page.locator("#preset-psd-path-advanced").evaluate(
    el => { (el as HTMLDetailsElement).open = true; });
  await page.locator("#preset-psd-path").fill("/tmp/original.psd");
  await page.getByRole("button", { name: "読み込む", exact: true }).click();
  await page.getByRole("button", { name: "詳細を編集" }).click();
  await page.getByRole("checkbox", { name: "mouth [0/0] 表示" }).uncheck();
  await page.getByRole("button", { name: "← 一覧へ" }).click();
  const draftBefore = await page.evaluate(() =>
    localStorage.getItem("tachie-motion.preset-draft.v1"));
  await Promise.all([
    page.waitForEvent("dialog").then((dialog) => dialog.dismiss()),
    page.getByRole("button", { name: "Finderで選ぶ" }).click(),
  ]);
  await expect(page.locator("#preset-psd-path")).toHaveValue("/tmp/original.psd");
  expect(loaded).toEqual(["/tmp/original.psd"]);
  expect(await page.evaluate(() => localStorage.getItem("tachie-motion.preset-draft.v1")))
    .toBe(draftBefore);
  expect(await page.evaluate(() => localStorage.getItem("tachie-motion.picker-dir.v1.psd")))
    .toBeNull();
  await page.getByRole("button", { name: "詳細を編集" }).click();
  await expect(page.getByRole("checkbox", { name: "mouth [0/0] 表示" })).not.toBeChecked();
  await page.getByRole("button", { name: "← 一覧へ" }).click();

  await Promise.all([
    page.waitForEvent("dialog").then((dialog) => dialog.accept()),
    page.getByRole("button", { name: "Finderで選ぶ" }).click(),
  ]);
  await expect(page.locator("#preset-psd-path")).toHaveValue("/Volumes/new-folder/other.psd");
  expect(loaded).toEqual(["/tmp/original.psd", "/Volumes/new-folder/other.psd"]);
  expect(await page.evaluate(() => localStorage.getItem("tachie-motion.picker-dir.v1.psd")))
    .toBe("/Volumes/new-folder");
});

test("plain Web launch cannot use Finder and retains advanced path fallback", async ({ page }) => {
  await page.route("http://127.0.0.1:8766/health", route => route.abort());
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Finderで選ぶ" })).toBeDisabled();
  await expect(page.getByText("Mac専用ランチャーで起動")).toBeVisible();
  await page.locator("#preset-psd-path-advanced").evaluate(
    el => { (el as HTMLDetailsElement).open = true; });
  await expect(page.locator("#preset-psd-path")).toBeEditable();
});

test("tailnet browser cannot access the macOS picker even if the local sidecar exists", async ({ page }) => {
  const remote = "https://example-node.my-tailnet.ts.net:8443";
  await page.route(remote + "/**", async route => {
    const forwarded = route.request().url().replace(remote, origin);
    const response = await route.fetch({
      url: forwarded, headers: { ...route.request().headers(), host: "127.0.0.1:8765" },
    });
    await route.fulfill({ response });
  });
  let healthRequests = 0;
  await page.route("http://127.0.0.1:8766/health", route => {
    healthRequests++;
    return route.fulfill({
      json: { picker: "mac-local", ready: true },
      headers: { "access-control-allow-origin": remote },
    });
  });
  await page.goto(remote + "/");
  await expect(page.getByRole("button", { name: "Finderで選ぶ" })).toBeDisabled();
  await expect(page.getByText("Mac本体のブラウザで利用")).toBeVisible();
  expect(healthRequests).toBe(0);
});
