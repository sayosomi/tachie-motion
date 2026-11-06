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
  // The exact same WAV path may be registered again as a separate item.
  await addWav(page, sameNameElsewhere);
  await expect(page.locator("[data-utterance-id]")).toHaveCount(2);
  const duplicateIds = await page.locator("[data-utterance-id]").evaluateAll(
    (nodes) => nodes.map((el) => el.getAttribute("data-utterance-id")));
  expect(duplicateIds[0]).not.toBe(duplicateIds[1]);
  await page.locator("[data-utterance-id]").first().locator(".utterance-item-select").click();
  await expect(page.locator("#speech-basename")).toHaveValue("second_line");
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

test("earlier concurrent WAV failure remains visible after a newer WAV succeeds", async ({ page }) => {
  const olderPath = "/Volumes/A/先行 だんもん.wav";
  const newerPath = "/Volumes/B/後行.wav";
  let releaseOlder: (() => void) | undefined;
  await page.route("**/api/wav", async (route) => {
    const { path } = route.request().postDataJSON() as { path: string };
    if (path === olderPath) {
      await new Promise<void>((resolve) => { releaseOlder = resolve; });
      return route.fulfill({ status: 422, json: { detail: "WAV解析に失敗しました" } });
    }
    return route.fulfill({ json: {
      samples: 1000, sample_rate: 1000, duration_seconds: 1,
    } });
  });
  await openSpeech(page);
  await addWav(page, olderPath);
  await expect.poll(() => Boolean(releaseOlder)).toBe(true);
  await addWav(page, newerPath);
  await expect(page.locator("[data-utterance-id]")).toHaveCount(1);
  await expect(page.locator(".utterance-item-select[aria-current=true]")).toContainText("後行.wav");
  releaseOlder!();
  const alert = page.getByRole("alert").filter({ hasText: olderPath });
  await expect(alert).toContainText("WAV解析に失敗しました");
  await expect(page.locator("[data-utterance-id]")).toHaveCount(1);
  await expect(page.locator("[data-utterance-id]").first().locator("small").first())
    .toHaveText(newerPath);
  await expect(page.locator(".utterance-item-select[aria-current=true]")).toContainText("後行.wav");
  await expect(page.locator("#speech-basename")).toHaveValue("speech_002");
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


test("Finder multi-select registers multiple NFD paths in one dialog", async ({ page }) => {
  const origin = "http://127.0.0.1:8765";
  const paths = ["/Volumes/A/あんこもん だんもん.wav", "/Volumes/B/あんこもん だんもん.wav"];
  await page.route("http://127.0.0.1:8766/health", (route) =>
    route.fulfill({ json: { picker: "mac-local", ready: true },
      headers: { "access-control-allow-origin": origin } }));
  const picks: Array<Record<string, unknown>> = [];
  await page.route("http://127.0.0.1:8766/pick", (route) => {
    if (route.request().method() === "OPTIONS") return route.fulfill({
      status: 204, headers: {
        "access-control-allow-origin": origin,
        "access-control-allow-methods": "POST",
        "access-control-allow-headers": "Content-Type, X-Tachie-Picker",
      } });
    picks.push(route.request().postDataJSON() as Record<string, unknown>);
    return route.fulfill({ json: { status: "selected", paths },
      headers: { "access-control-allow-origin": origin } });
  });
  await page.route("**/api/wav", (route) => route.fulfill({
    json: { samples: 1200, sample_rate: 1000, duration_seconds: 1.2 },
  }));
  await openSpeech(page);
  await page.getByRole("button", { name: "Finderで選ぶ" }).click();
  await expect(page.locator("[data-utterance-id]")).toHaveCount(2);
  expect(picks).toHaveLength(1);
  expect(picks[0]).toMatchObject({ kind: "wav", multiple: true });
  const displayed = await page.locator("[data-utterance-id] .utterance-item-details small:first-of-type")
    .allTextContents();
  expect(displayed).toEqual(paths);
});

test("drag handle reorders WAV rows without changing their edit state", async ({ page }) => {
  await page.route("**/api/wav", (route) => route.fulfill({
    json: { samples: 1000, sample_rate: 1000, duration_seconds: 1 },
  }));
  await openSpeech(page);
  await addWav(page, "/tmp/first.wav");
  await expect(page.locator("[data-utterance-id]")).toHaveCount(1);
  await expect(page.locator(".utterance-item-select[aria-current=true]")).toContainText("first.wav");
  await page.locator("#speech-basename").fill("first");
  await addWav(page, "/tmp/second.wav");
  await expect(page.locator("[data-utterance-id]")).toHaveCount(2);
  await expect(page.locator(".utterance-item-select[aria-current=true]")).toContainText("second.wav");
  await page.locator("#speech-basename").fill("second");
  const ids = await page.locator("[data-utterance-id]").evaluateAll(
    (nodes) => nodes.map((node) => node.getAttribute("data-utterance-id")));
  await page.getByRole("button", { name: "ドラッグで移動: 2 second.wav" })
    .dragTo(page.locator("[data-utterance-id]").first(), {
      targetPosition: { x: 20, y: 5 },
    });
  await expect(page.locator("[data-utterance-id]").first()).toHaveAttribute(
    "data-utterance-id", ids[1]);
  await page.locator("[data-utterance-id]").nth(1).locator(".utterance-item-select").click();
  await expect(page.locator("#speech-basename")).toHaveValue("first");
});

test("browser WAV controls read through bounded POST API for single and all playback", async ({ page }) => {
  await page.route("**/api/wav", (route) => route.fulfill({
    json: { samples: 4000, sample_rate: 8000, duration_seconds: 0.5 },
  }));
  const audio = Buffer.alloc(44 + 8000);
  audio.write("RIFF", 0); audio.writeUInt32LE(audio.length - 8, 4);
  audio.write("WAVEfmt ", 8); audio.writeUInt32LE(16, 16);
  audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(8000, 24); audio.writeUInt32LE(16000, 28);
  audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34);
  audio.write("data", 36); audio.writeUInt32LE(8000, 40);
  const requested: string[] = [];
  await page.route("**/api/wav-playback", (route) => {
    requested.push((route.request().postDataJSON() as { path: string }).path);
    return route.fulfill({ status: 200, body: audio, contentType: "audio/wav" });
  });
  await openSpeech(page);
  await addWav(page, "/tmp/a.wav");
  await addWav(page, "/tmp/b.wav");
  await page.getByRole("button", { name: "選択中を再生" }).click();
  await expect.poll(() => requested.length).toBe(1);
  expect(requested[0]).toBe("/tmp/b.wav");
  await page.getByRole("button", { name: "全件を連続再生" }).click();
  await expect.poll(() => requested.length, { timeout: 10000 }).toBe(3);
  expect(requested).toEqual(["/tmp/b.wav", "/tmp/a.wav", "/tmp/b.wav"]);
});

test("batch exports every WAV in list order and retains individual failures", async ({ page }) => {
  await page.route("**/api/wav", (route) => route.fulfill({
    json: { samples: 800, sample_rate: 8000, duration_seconds: 0.1 },
  }));
  const requests: Array<Record<string, unknown>> = [];
  await page.route("**/api/preset-utterance-export", (route) => {
    const payload = route.request().postDataJSON() as Record<string, unknown>;
    requests.push(payload);
    if (payload.wav === "/tmp/b.wav") {
      return route.fulfill({ status: 400, json: { detail: "synthetic failed" } });
    }
    return route.fulfill({ json: {
      mov: "/tmp/output/" + payload.basename + ".mov",
      otio: "/tmp/output/" + payload.basename + ".otio",
      frames: 30, sample_count: 800,
    } });
  });
  await openSpeech(page);
  await addWav(page, "/tmp/a.wav");
  await addWav(page, "/tmp/b.wav");
  await addWav(page, "/tmp/c.wav");
  await page.getByRole("button", { name: "すべて保存（MOV・OTIO）" }).click();
  await expect(page.getByText("一括書き出し完了：成功 2 件／失敗 1 件", { exact: false }))
    .toBeVisible();
  expect(requests.map((r) => r.wav)).toEqual(["/tmp/a.wav", "/tmp/b.wav", "/tmp/c.wav"]);
  expect(requests.map((r) => r.basename)).toEqual(["speech_001", "speech_002", "speech_003"]);
  await expect(page.locator("[data-utterance-id]").nth(1)).toContainText("書き出し失敗");
  await expect(page.locator("[data-utterance-id]").nth(2)).toContainText("書き出し済み");
});

test("batch preflight blocks colliding output filenames before generating MOVs", async ({ page }) => {
  await page.route("**/api/wav", (route) => route.fulfill({
    json: { samples: 1000, sample_rate: 1000, duration_seconds: 1 },
  }));
  let calls = 0;
  await page.route("**/api/preset-utterance-export", (route) => {
    calls++;
    return route.fulfill({ status: 500, json: { detail: "should not export" } });
  });
  await openSpeech(page);
  await addWav(page, "/tmp/first.wav");
  await expect(page.locator("[data-utterance-id]")).toHaveCount(1);
  await addWav(page, "/tmp/second.wav");
  await expect(page.locator("[data-utterance-id]")).toHaveCount(2);
  await expect(page.locator(".utterance-item-select[aria-current=true]")).toContainText("second.wav");
  await page.locator("#speech-basename").fill("speech_001");
  await page.getByRole("button", { name: "すべて保存（MOV・OTIO）" }).click();
  await expect(page.getByText("複数のセリフが同じ出力先", { exact: false })).toBeVisible();
  expect(calls).toBe(0);
});
