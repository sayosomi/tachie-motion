import { expect, test, type Page } from "@playwright/test";

// These browser scenarios mock MOV/OTIO completion. Reserve progress in the
// same mock transport; never create an orphan job on the real local API.
test.beforeEach(async ({ page }) => {
  await page.route("**/api/export-progress-reserve", (route) =>
    route.fulfill({ json: { registered: true } }));
});

/** Image-backed chooser selects by stable preset ID. */
const presetTrigger = (scope: import("@playwright/test").Locator) =>
  scope.locator(".utterance-row-preset .preset-picker-trigger");
async function choosePreset(scope: import("@playwright/test").Locator, id: string) {
  await presetTrigger(scope).click();
  await scope.locator(`.preset-picker-option[data-preset-id="${id}"]`).click();
}

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
  await page.route("**/api/preset-batch-mov-destination", (route) =>
    route.fulfill({ json: { state: "available", canonical_output_dir: "/tmp/output" } }));
  await page.route("**/api/preset-combined-otio-destination", (route) =>
    route.fulfill({ json: { state: "available", canonical_output_dir: "/tmp/output" } }));
  await page.route("**/api/preset-combined-otio", (route) => {
    const body = route.request().postDataJSON() as { basename: string; entries: unknown[] };
    return route.fulfill({ json: {
      otio: "/tmp/output/" + body.basename + ".otio", entries: body.entries.length,
    } });
  });
  await page.route("**/api/preset-batch-mov-export", (route) => {
    const body = route.request().postDataJSON() as { basename: string };
    return route.fulfill({ json: { mov: "/tmp/output/" + body.basename + ".mov",
      frames: 30, sample_count: 800, sample_rate: 8000 } });
  });
  await page.route("**/api/preset-batch-reuse-candidate", (route) => {
    const request = route.request().postDataJSON() as { suggested_basename: string };
    return route.fulfill({ json: {
      basename: request.suggested_basename, reuse: false,
    } });
  });
  await page.route("**/api/preset-batch-check-names", (route) =>
    route.fulfill({ json: { valid: true } }));
  await page.route("**/api/preset-batch-start", (route) =>
    route.fulfill({ json: { batch_id: "test-session" } }));
  await page.route("**/api/preset-batch-cancel", (route) =>
    route.fulfill({ json: { released: true } }));
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
  await page.locator('[data-selected="true"] .utterance-row-mode select').selectOption("open");
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
  await expect(page.locator('[data-selected="true"] .utterance-row-mode select')).toHaveValue("open");
  await expect(page.locator("#speech-basename")).toHaveValue("first_line");
  await expect(page.locator("#speech-fps")).toHaveValue("30");
  await page.locator("[data-utterance-id]").first().locator(".utterance-item-select").click();
  await expect(page.locator('[data-selected="true"] .utterance-row-mode select')).toHaveValue("none");
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
  await expect(page.locator("#speech-basename")).toHaveValue("001_character_後行");
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
      mov: "/tmp/output/001_character_voice 日本語.mov",
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
  await expect(page.getByRole("button", { name: "MOVを書き出す" })).toBeEnabled();
  await page.getByRole("button", { name: "MOVを書き出す" }).click();
  await expect(page.getByText("書き出し完了・30フレーム")).toBeVisible();
  expect(exports).toHaveLength(1);
  expect(exports[0].wav).toBe(path);
  expect(exports[0].mode).toBe("none");
  expect(exports[0].basename).toBe("001_character_voice 日本語");
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
  const grip = await page.locator(".utterance-item").first()
    .locator(".utterance-drag-handle").boundingBox();
  const play = await page.locator(".utterance-item").first()
    .locator(".utterance-item-play").boundingBox();
  const name = await page.locator(".utterance-item").first()
    .locator(".utterance-item-select").boundingBox();
  expect(grip && play && name).toBeTruthy();
  expect(grip!.x).toBeLessThan(play!.x);
  expect(play!.x).toBeLessThan(name!.x);
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
  await page.getByRole("button", { name: /プリセット編集を閉じる/ }).click();
  // The selected editor may load a waveform without starting playback.
  const beforeSingle = requested.length;
  await page.locator(".utterance-item-play").nth(1).click();
  await expect.poll(() => requested.length - beforeSingle).toBe(1);
  expect(requested[beforeSingle]).toBe("/tmp/b.wav");
  const beforeAll = requested.length;
  await page.getByRole("button", { name: "全件を連続再生" }).click();
  await expect.poll(() => requested.length - beforeAll, { timeout: 10000 }).toBe(2);
  expect(requested.slice(beforeAll)).toEqual(["/tmp/a.wav", "/tmp/b.wav"]);
});

test("batch exports every WAV in list order and retains individual failures", async ({ page }) => {
  await page.route("**/api/wav", (route) => route.fulfill({
    json: { samples: 800, sample_rate: 8000, duration_seconds: 0.1 },
  }));
  const requests: Array<Record<string, unknown>> = [];

  await openSpeech(page);
  await page.route("**/api/preset-batch-mov-export", (route) => {
    const payload = route.request().postDataJSON() as Record<string, unknown>;
    requests.push(payload);
    if (payload.wav === "/tmp/b.wav") {
      return route.fulfill({ status: 400, json: { detail: "synthetic failed" } });
    }
    return route.fulfill({ json: {
      mov: "/tmp/output/" + payload.basename + ".mov",
      frames: 30, sample_count: 800, sample_rate: 8000,
    } });
  });
  await addWav(page, "/tmp/a.wav");
  await addWav(page, "/tmp/b.wav");
  await addWav(page, "/tmp/c.wav");
  await page.getByRole("radio", { name: /^全件/ }).check();
  await expect(page.getByRole("heading", { name: "書き出し", exact: true })).toHaveCount(1);
  await expect(page.getByRole("heading", { name: "一括書き出し", exact: true })).toHaveCount(0);
  await expect(page.getByText("口パク「なし」が3件", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "全件を書き出す" }).click();
  await expect(page.locator(".utterance-export-panel")
    .getByText("旧MOV・OTIOは変更していません", { exact: false }))
    .toBeVisible();
  expect(requests.map((r) => r.wav)).toEqual(["/tmp/a.wav", "/tmp/b.wav", "/tmp/c.wav"]);
  expect(requests.map((r) => r.basename)).toEqual(["001_character_a", "002_character_b", "003_character_c"]);
  await expect(page.locator("[data-utterance-id]").nth(1)).toContainText("書き出し失敗");
  await expect(page.locator("[data-utterance-id]").nth(2)).not.toContainText("書き出し済み");
});

test("batch preflight identifies the offending WAV and the missing open shape", async ({ page }) => {
  await page.route("**/api/wav", (route) => route.fulfill({ json: {
    samples: 1000, sample_rate: 1000, duration_seconds: 1,
    source_identity: "1:2:3:4:5",
  } }));
  await openSpeech(page);
  await addWav(page, "/tmp/010_あんこもん.wav");
  await addWav(page, "/tmp/011_あんこもん.wav");
  await page.locator("[data-utterance-id]").nth(1)
    .locator(".utterance-row-mode select").selectOption("open");
  await page.getByRole("radio", { name: /^全件/ }).check();
  const alert = page.getByRole("alert").filter({ hasText: "一括書き出しを開始できません" });
  await expect(alert).toContainText("2番 /tmp/011_あんこもん.wav");
  await expect(alert).toContainText("open：プリセット「通常」の開いた口レイヤーが未設定です。");
  await page.locator("[data-utterance-id]").nth(1)
    .locator(".utterance-row-mode select").selectOption("none");
  await expect(alert).toHaveCount(0);
  await expect(page.getByText("書き出し予定を確認済み", { exact: false })).toBeVisible();
});

test("batch preflight blocks colliding output filenames before generating MOVs", async ({ page }) => {
  await page.route("**/api/wav", (route) => route.fulfill({
    json: { samples: 1000, sample_rate: 1000, duration_seconds: 1 },
  }));
  let calls = 0;
  await page.route("**/api/preset-batch-mov-export", (route) => {
    calls++;
    return route.fulfill({ status: 500, json: { detail: "should not export" } });
  });
  await openSpeech(page);
  await addWav(page, "/tmp/first.wav");
  await expect(page.locator("[data-utterance-id]")).toHaveCount(1);
  await addWav(page, "/tmp/second.wav");
  await expect(page.locator("[data-utterance-id]")).toHaveCount(2);
  await expect(page.locator(".utterance-item-select[aria-current=true]")).toContainText("second.wav");
  await page.getByRole("radio", { name: /^全件/ }).check();
  await page.locator("#batch-mov-template").fill("same");
  await expect(page.getByText("MOVの保存名が重複", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "全件を書き出す" })).toBeDisabled();
  expect(calls).toBe(0);
});

test("batch export requires confirmation before overwriting existing output pairs", async ({ page }) => {
  await page.route("**/api/wav", (route) => route.fulfill({
    json: { samples: 800, sample_rate: 8000, duration_seconds: 0.1 },
  }));
  let exports = 0;
  await page.route("**/api/preset-batch-mov-export", (route) => {
    exports++;
    return route.fulfill({ status: 500, json: { detail: "unexpected export" } });
  });
  await openSpeech(page);
  // Last registered route wins in Playwright; override openSpeech's available default.
  await page.route("**/api/preset-batch-mov-destination", (route) => route.fulfill({
    json: { state: "complete", suggested_basename: "speech_001_002",
      canonical_output_dir: "/tmp/output" },
  }));
  await addWav(page, "/tmp/voice.wav");
  await expect(page.locator("[data-utterance-id]")).toHaveCount(1);
  const dialog = page.waitForEvent("dialog").then(async (shown) => {
    expect(shown.message()).toContain("既存のMOV・全体OTIOを合計1件上書き");
    await shown.dismiss();
  });
  await page.getByRole("radio", { name: /^全件/ }).check();
  await page.getByRole("button", { name: "全件を書き出す" }).click();
  await dialog;
  await expect(page.getByText("一括書き出しをキャンセルしました")).toBeVisible();
  expect(exports).toBe(0);
});

test("batch locks the preset selector throughout an in-progress render", async ({ page }) => {
  await page.route("**/api/wav", (route) => route.fulfill({
    json: { samples: 800, sample_rate: 8000, duration_seconds: 0.1 },
  }));
  let releaseFirst: (() => void) | undefined;
  const payloads: Array<Record<string, unknown>> = [];

  await openSpeech(page);
  await page.route("**/api/preset-batch-mov-export", async (route) => {
    const payload = route.request().postDataJSON() as Record<string, unknown>;
    payloads.push(payload);
    if (payload.wav === "/tmp/a.wav") {
      await new Promise<void>((resolve) => { releaseFirst = resolve; });
    }
    await route.fulfill({ json: {
      mov: "/tmp/output/" + payload.basename + ".mov",
      frames: 30, sample_count: 800, sample_rate: 8000,
    } });
  });
  await page.getByRole("button", { name: "プリセット", exact: true }).click();
  await page.getByRole("button", { name: "＋ 作成" }).click();
  await expect(page.getByRole("heading", { name: "編集" })).toBeVisible();
  await page.getByRole("button", { name: "← 一覧へ" }).click();
  await page.getByRole("button", { name: "セリフ", exact: true }).click();
  await expect(page.locator("#speech-wav-path")).toBeAttached();
  await addWav(page, "/tmp/a.wav");
  await expect(page.locator("[data-utterance-id]")).toHaveCount(1);
  await addWav(page, "/tmp/b.wav");
  await expect(page.locator("[data-utterance-id]")).toHaveCount(2);
  const chosenRow = page.locator('[data-selected="true"]');
  await presetTrigger(chosenRow).click();
  await expect(chosenRow.locator(".preset-picker-option")).toHaveCount(2);
  await presetTrigger(chosenRow).click();
  const assignedPreset = await presetTrigger(chosenRow).getAttribute("data-selected-preset-id");

  await page.getByRole("radio", { name: /^全件/ }).check();
  await page.getByRole("button", { name: "全件を書き出す" }).click();
  await expect.poll(() => Boolean(releaseFirst)).toBe(true);
  await expect(page.getByRole("dialog")).toBeVisible();
  // The overlay deliberately blocks editing other rows during a render.
  await expect(presetTrigger(page.locator('[data-selected="true"]'))).toBeDisabled();
  await expect(presetTrigger(page.locator('[data-selected="true"]'))).toHaveAttribute("data-selected-preset-id", assignedPreset!);
  releaseFirst!();
  await expect(page.getByText("一括書き出し完了：MOV 2件／全体OTIO", { exact: false }))
    .toBeVisible();
  await expect(presetTrigger(page.locator('[data-selected="true"]'))).toBeEnabled();
  expect(payloads.map((item) => item.wav)).toEqual(["/tmp/a.wav", "/tmp/b.wav"]);
});

test("media error stops the playlist and releases Blob URLs on error and on normal completion", async ({ page }) => {
  await page.addInitScript(() => {
    const original = URL.revokeObjectURL;
    const target = window as Window & { __revokedBlobUrls: string[] };
    target.__revokedBlobUrls = [];
    URL.revokeObjectURL = (url: string) => {
      target.__revokedBlobUrls.push(url);
      original.call(URL, url);
    };
  });
  await page.route("**/api/wav", (route) => route.fulfill({
    json: { samples: 16000, sample_rate: 8000, duration_seconds: 2 },
  }));
  const wav = Buffer.alloc(44 + 32000);
  wav.write("RIFF", 0); wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write("data", 36); wav.writeUInt32LE(32000, 40);
  const requests: string[] = [];
  await page.route("**/api/wav-playback", (route) => {
    requests.push((route.request().postDataJSON() as { path: string }).path);
    return route.fulfill({ body: wav, contentType: "audio/wav" });
  });
  await openSpeech(page);
  await addWav(page, "/tmp/one.wav");
  await addWav(page, "/tmp/two.wav");
  await page.getByRole("button", { name: /プリセット編集を閉じる/ }).click();
  const player = page.locator(".utterance-playback audio");

  const beforeFirst = requests.length;
  await page.getByRole("button", { name: "全件を連続再生" }).click();
  await expect(player).toHaveAttribute("src", /^blob:/);
  const brokenUrl = await player.getAttribute("src");
  await player.evaluate((node) => node.dispatchEvent(new Event("error")));
  await expect(page.getByText("音声の再生に失敗:", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "停止" })).toBeDisabled();
  await expect.poll(async () => player.evaluate((node) => node.hasAttribute("src"))).toBe(false);
  const firstRevoked = await page.evaluate(
    () => (window as Window & { __revokedBlobUrls: string[] }).__revokedBlobUrls);
  expect(firstRevoked).toContain(brokenUrl);
  expect(requests.slice(beforeFirst)).toEqual(["/tmp/one.wav"]);

  const beforeRestart = requests.length;
  await page.getByRole("button", { name: "全件を連続再生" }).click();
  await expect.poll(() => requests.length - beforeRestart).toBe(1);
  await expect.poll(async () => {
    const src = await player.getAttribute("src");
    return Boolean(src?.startsWith("blob:"));
  }).toBe(true);
  const firstUrl = await player.getAttribute("src");
  await player.evaluate((node) => node.dispatchEvent(new Event("ended")));
  await expect.poll(() => requests.length - beforeRestart).toBe(2);
  await expect.poll(async () => {
    const src = await player.getAttribute("src");
    return Boolean(src?.startsWith("blob:") && src !== firstUrl);
  }).toBe(true);
  const secondUrl = await player.getAttribute("src");
  await player.evaluate((node) => node.dispatchEvent(new Event("ended")));
  await expect(page.getByText("再生が終了しました")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "停止" })).toBeDisabled();
  await expect.poll(async () => player.evaluate((node) => node.hasAttribute("src"))).toBe(false);
  const revoked = await page.evaluate(
    () => (window as Window & { __revokedBlobUrls: string[] }).__revokedBlobUrls);
  expect(revoked).toContain(firstUrl);
  expect(revoked).toContain(secondUrl);
});

test("Finder multi-WAV partial failure preserves successful selection and reports the failed path", async ({ page }) => {
  const origin = "http://127.0.0.1:8765";
  const okPath = "/tmp/good だんもん.wav";
  const badPath = "/tmp/bad.wav";
  await page.route("http://127.0.0.1:8766/health", (route) =>
    route.fulfill({ json: { picker: "mac-local", ready: true },
      headers: { "access-control-allow-origin": origin } }));
  await page.route("http://127.0.0.1:8766/pick", (route) => {
    if (route.request().method() === "OPTIONS") return route.fulfill({
      status: 204, headers: {
        "access-control-allow-origin": origin,
        "access-control-allow-methods": "POST",
        "access-control-allow-headers": "Content-Type, X-Tachie-Picker",
      } });
    return route.fulfill({ json: { status: "selected", paths: [okPath, badPath] },
      headers: { "access-control-allow-origin": origin } });
  });
  await page.route("**/api/wav", (route) =>
    (route.request().postDataJSON() as { path: string }).path === badPath
      ? route.fulfill({ status: 422, json: { detail: "invalid PCM" } })
      : route.fulfill({ json: {
        samples: 800, sample_rate: 8000, duration_seconds: 0.1,
      } }));
  await openSpeech(page);
  await page.getByRole("button", { name: "Finderで選ぶ" }).click();
  await expect(page.locator("[data-utterance-id]")).toHaveCount(1);
  await expect(page.locator("[data-utterance-id]").first()).toContainText(okPath);
  await expect(page.getByRole("alert").filter({ hasText: badPath }))
    .toContainText("invalid PCM");
});



test("cancelled Finder multi-select leaves all registered WAVs untouched", async ({ page }) => {
  const origin = "http://127.0.0.1:8765";
  await page.route("**/api/wav", (route) => route.fulfill({
    json: { samples: 800, sample_rate: 8000, duration_seconds: 0.1 },
  }));
  await page.route("http://127.0.0.1:8766/health", (route) =>
    route.fulfill({ json: { picker: "mac-local", ready: true },
      headers: { "access-control-allow-origin": origin } }));
  await page.route("http://127.0.0.1:8766/pick", (route) => {
    if (route.request().method() === "OPTIONS") return route.fulfill({
      status: 204, headers: {
        "access-control-allow-origin": origin,
        "access-control-allow-methods": "POST",
        "access-control-allow-headers": "Content-Type, X-Tachie-Picker",
      } });
    return route.fulfill({ json: { status: "cancelled" },
      headers: { "access-control-allow-origin": origin } });
  });
  await openSpeech(page);
  await addWav(page, "/tmp/existing.wav");
  await expect(page.locator("[data-utterance-id]")).toHaveCount(1);
  await page.locator("#speech-basename").fill("keep_settings");
  const initialId = await page.locator("[data-utterance-id]").first()
    .getAttribute("data-utterance-id");
  await page.getByRole("button", { name: "Finderで選ぶ" }).click();
  await expect(page.locator("[data-utterance-id]")).toHaveCount(1);
  await expect(page.locator("[data-utterance-id]").first())
    .toHaveAttribute("data-utterance-id", initialId!);
  await expect(page.locator("#speech-basename")).toHaveValue("keep_settings");
});

test("batch destination rejects unsafe and recovery-required names before any MOV export", async ({ page }) => {
  await page.route("**/api/wav", (route) => route.fulfill({
    json: { samples: 800, sample_rate: 8000, duration_seconds: 0.1 },
  }));
  let renders = 0;
  await openSpeech(page);
  await page.route("**/api/preset-batch-mov-export", (route) => {
    renders++;
    return route.fulfill({ status: 500, json: { detail: "should not render" } });
  });
  await addWav(page, "/tmp/unsafe.wav");
  await addWav(page, "/tmp/recovery.wav");
  await expect(page.locator("[data-utterance-id]")).toHaveCount(2);
  await page.getByRole("radio", { name: /^全件/ }).check();
  for (const unsafe of ["unsafe", "recovery_required", "partial"]) {
    await page.route("**/api/preset-batch-mov-destination", (route) =>
      route.fulfill({ json: { state: unsafe, canonical_output_dir: "/tmp/output" } }));
    await page.locator("#batch-mov-template").fill("{番号}_bad_" + unsafe);
    await expect(page.getByText("出力先の安全確認に失敗", { exact: false })).toBeVisible();
    await expect(page.getByRole("button", { name: "全件を書き出す" })).toBeDisabled();
  }
  expect(renders).toBe(0);
});


test("single export locks every WAV's edits and new additions when selection changes", async ({ page }) => {
  await page.route("**/api/wav", (route) => route.fulfill({
    json: { samples: 800, sample_rate: 8000, duration_seconds: 0.1 },
  }));
  let release: (() => void) | undefined;
  let exported = 0;
  await page.route("**/api/preset-utterance-export", async (route) => {
    exported++;
    await new Promise<void>((resolve) => { release = resolve; });
    await route.fulfill({ json: {
      mov: "/tmp/output/speech_001.mov",
      frames: 30, sample_count: 800,
    } });
  });
  await openSpeech(page);
  await addWav(page, "/tmp/a.wav");
  await expect(page.locator("[data-utterance-id]")).toHaveCount(1);
  await addWav(page, "/tmp/b.wav");
  await expect(page.locator("[data-utterance-id]")).toHaveCount(2);
  await page.locator("[data-utterance-id]").first().locator(".utterance-item-select").click();
  await page.getByRole("button", { name: "MOVを書き出す" }).click();
  await expect.poll(() => Boolean(release)).toBe(true);
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(presetTrigger(page.locator('[data-selected="true"]'))).toBeDisabled();
  await expect(page.locator('[data-selected="true"] .utterance-row-mode select')).toBeDisabled();
  await expect(page.locator(".utterance-row-preset .preset-picker-trigger:disabled")).toHaveCount(2);
  await expect(page.locator(".utterance-row-mode select:disabled")).toHaveCount(2);
  await expect(page.locator("#speech-fps")).toBeDisabled();
  await expect(page.locator("#speech-basename")).toBeDisabled();
  await expect(page.locator("#speech-wav-path")).toBeDisabled();
  await expect(page.getByRole("button", { name: "WAVを確認" })).toBeDisabled();
  await expect(page.locator("[data-utterance-id]").nth(1)
    .getByRole("button", { name: /削除:/ })).toBeDisabled();
  await expect(page.locator("[data-utterance-id]").nth(1)
    .getByRole("button", { name: /ドラッグで移動:/ })).toBeDisabled();
  release!();
  await expect(presetTrigger(page.locator('[data-selected="true"]'))).toBeEnabled();
  await expect(page.locator("#speech-wav-path")).toBeEnabled();
  expect(exported).toBe(1);
});

test("batch preview is invalidated when the actual destination changes before export", async ({ page }) => {
  await page.route("**/api/wav", (route) => route.fulfill({
    json: { samples: 800, sample_rate: 8000, duration_seconds: 0.1 },
  }));
  let outputExists = false;
  let submitted = 0;
  await openSpeech(page);
  await page.route("**/api/preset-batch-mov-destination", (route) => route.fulfill({
    json: outputExists ? {
      state: "complete", suggested_basename: "speech_001_002",
      canonical_output_dir: "/tmp/output",
    } : { state: "available", suggested_basename: "speech_001_002",
      canonical_output_dir: "/tmp/output" },
  }));
  await page.route("**/api/preset-batch-mov-export", (route) => {
    submitted++;
    return route.fulfill({ status: 500, json: { detail: "unexpected export" } });
  });
  await addWav(page, "/tmp/a.wav");
  await expect(page.locator("[data-utterance-id]")).toHaveCount(1);
  await page.getByRole("radio", { name: /^全件/ }).check();
  const plan = page.locator(".export-plan-items li").first();
  await expect(plan).toContainText("001_character_a.mov");
  await expect(plan).toContainText("新規保存");
  outputExists = true;
  await page.getByRole("button", { name: "全件を書き出す" }).click();
  await expect(page.getByText("出力予定が変更されました", { exact: false })).toBeVisible();
  expect(submitted).toBe(0);
  await expect(plan).toContainText("上書き");
  await expect(page.getByRole("button", { name: "全件を書き出す" })).toBeEnabled();
});

test("clicking the loading WAV row cancels its fetch instead of starting a second request", async ({ page }) => {
  let release: (() => void) | undefined;
  let requests = 0;
  await page.route("**/api/wav", (route) => route.fulfill({
    json: { samples: 8000, sample_rate: 8000, duration_seconds: 1 },
  }));
  await page.route("**/api/wav-playback", async (route) => {
    requests++;
    await new Promise<void>((resolve) => { release = resolve; });
    try { await route.abort(); } catch { /* The browser already aborted it. */ }
  });
  await openSpeech(page);
  await addWav(page, "/tmp/loading.wav");
  await expect(page.locator("[data-utterance-id]")).toHaveCount(1);
  await page.getByRole("button", { name: /プリセット編集を閉じる/ }).click();
  const beforePlay = requests;
  await page.locator(".utterance-item-play").click();
  await expect.poll(() => Boolean(release)).toBe(true);
  await expect(page.getByRole("button", { name: /読み込み中止:/ })).toBeVisible();
  await expect(page.locator(".utterance-loading-label")).toBeVisible();
  await expect(page.locator(".utterance-loading-label")).toContainText("読み込み中止");
  await page.getByRole("button", { name: /読み込み中止:/ }).click();
  await expect(page.locator(".utterance-loading-label")).toHaveCount(0);
  release!();
  await expect(page.locator(".utterance-item-play")).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByRole("button", { name: /再生: 1 loading.wav/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "停止" })).toBeDisabled();
  await expect(page.getByText("音声の再生に失敗:", { exact: false })).toHaveCount(0);
  await expect.poll(() => requests - beforePlay).toBe(1);
});

test("inline WAV pause, resume and seeking operate on the currently loaded audio", async ({ page }) => {
  await page.route("**/api/wav", (route) => route.fulfill({
    json: { samples: 96000, sample_rate: 8000, duration_seconds: 12 },
  }));
  const wav = Buffer.alloc(44 + 96000 * 2);
  wav.write("RIFF", 0); wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write("data", 36); wav.writeUInt32LE(96000 * 2, 40);
  const requests: string[] = [];
  await page.route("**/api/wav-playback", (route) => {
    requests.push((route.request().postDataJSON() as { path: string }).path);
    return route.fulfill({ body: wav, contentType: "audio/wav" });
  });
  await openSpeech(page);
  await addWav(page, "/tmp/long.wav");
  await expect(page.locator("[data-utterance-id]")).toHaveCount(1);
  await page.getByRole("button", { name: /プリセット編集を閉じる/ }).click();
  const beforePlay = requests.length;
  await page.locator(".utterance-item-play").click();
  const player = page.locator(".utterance-playback audio");
  await expect(page.getByRole("button", { name: /一時停止:/ })).toBeVisible();
  await expect(player).toHaveAttribute("src", /^blob:/);
  await page.getByRole("button", { name: /一時停止:/ }).click();
  await expect(page.getByRole("button", { name: /再生: 1 long.wav/ })).toBeVisible();
  await expect.poll(() => player.evaluate((el) => (el as HTMLAudioElement).paused)).toBe(true);
  const seek = page.getByRole("slider", { name: /再生位置: long.wav/ });
  const rect = await seek.boundingBox();
  expect(rect).not.toBeNull();
  await seek.click({ position: { x: rect!.width * 0.6, y: rect!.height / 2 } });
  await expect.poll(() => player.evaluate((el) => (el as HTMLAudioElement).currentTime))
    .toBeGreaterThan(4);
  await page.getByRole("button", { name: /再生: 1 long.wav/ }).click();
  await expect(page.getByRole("button", { name: /一時停止:/ })).toBeVisible();
  await page.getByRole("button", { name: "停止", exact: true }).click();
  await expect.poll(() => player.evaluate((el) => el.hasAttribute("src"))).toBe(false);
  expect(requests.slice(beforePlay)).toEqual(["/tmp/long.wav"]);
});


test("a drag started before single export cannot reorder after the export lock engages", async ({ page }) => {
  await page.route("**/api/wav", (route) => route.fulfill({
    json: { samples: 800, sample_rate: 8000, duration_seconds: 0.1 },
  }));
  let releaseExport: (() => void) | undefined;
  await page.route("**/api/preset-utterance-export", async (route) => {
    await new Promise<void>((resolve) => { releaseExport = resolve; });
    await route.fulfill({ json: {
      mov: "/tmp/output/speech_001.mov",
      frames: 30, sample_count: 800,
    } });
  });
  await openSpeech(page);
  await addWav(page, "/tmp/first.wav");
  await addWav(page, "/tmp/second.wav");
  const rows = page.locator("[data-utterance-id]");
  await expect(rows).toHaveCount(2);
  const ids = await rows.evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute("data-utterance-id")));

  // Keep an actual React dragStart active, rather than completing dragTo first.
  await rows.nth(1).locator(".utterance-drag-handle").evaluate((node) => {
    const dataTransfer = new DataTransfer();
    node.dispatchEvent(new DragEvent("dragstart", {
      bubbles: true, cancelable: true, dataTransfer,
    }));
  });
  await rows.first().evaluate((node) => {
    node.dispatchEvent(new DragEvent("dragover", {
      bubbles: true, cancelable: true, dataTransfer: new DataTransfer(),
    }));
  });
  await expect(rows.first()).toHaveAttribute("data-drop-target", "true");
  await rows.first().locator(".utterance-item-select").click();
  await page.getByRole("button", { name: "MOVを書き出す" }).click();
  await expect.poll(() => Boolean(releaseExport)).toBe(true);
  await expect(rows.nth(1).locator(".utterance-drag-handle")).toBeDisabled();
  await expect(rows.first()).toHaveAttribute("data-drop-target", "false");

  // Deliver the drop event even though the export has invalidated the drag.
  const dispatched = await rows.first().evaluate((node) => {
    return node.dispatchEvent(new DragEvent("drop", {
      bubbles: true, cancelable: true,
      clientY: node.getBoundingClientRect().top + 3,
      dataTransfer: new DataTransfer(),
    }));
  });
  expect(dispatched).toBe(false); // onDrop received the event and prevented default.
  await expect(rows.first()).toHaveAttribute("data-utterance-id", ids[0]!);
  await expect(rows.nth(1)).toHaveAttribute("data-utterance-id", ids[1]!);

  releaseExport!();
  await expect(page.locator(".utterance-drag-handle").first()).toBeEnabled();
  await expect(rows.first()).toHaveAttribute("data-utterance-id", ids[0]!);
  await expect(rows.nth(1)).toHaveAttribute("data-utterance-id", ids[1]!);
});


test("WAV list shows each item's preset and lip mode after editing and reordering", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.route("**/api/wav", (route) => route.fulfill({
    json: { samples: 8000, sample_rate: 8000, duration_seconds: 1 },
  }));
  await openSpeech(page);
  await page.getByRole("button", { name: "プリセット", exact: true }).click();
  await page.getByRole("button", { name: "＋ 作成" }).click();
  await page.getByRole("button", { name: "← 一覧へ" }).click();
  await page.getByRole("button", { name: "セリフ", exact: true }).click();

  await addWav(page, "/tmp/first.wav");
  await addWav(page, "/tmp/second.wav");
  const rows = page.locator("[data-utterance-id]");
  await expect(rows).toHaveCount(2);
  const screenWidth = await page.locator(".utterance-workspace").evaluate(
    (node) => node.getBoundingClientRect().width);
  expect(screenWidth).toBeGreaterThan(1300);
  const positions = await rows.first().evaluate((row) => {
    const x = (selector: string) => row.querySelector(selector)!.getBoundingClientRect().left;
    return [x(".utterance-item-select"), x(".utterance-row-preset"),
      x(".utterance-row-mode"), x(".utterance-item-actions")];
  });
  expect(positions[0]).toBeLessThan(positions[1]);
  expect(positions[1]).toBeLessThan(positions[2]);
  expect(positions[2]).toBeLessThan(positions[3]);
  await expect(page.locator(".utterance-list-columns")).toContainText("WAV");
  await expect(page.locator(".utterance-list-columns")).toContainText("プリセット");
  await expect(page.locator(".utterance-list-columns")).toContainText("口パク");
  await expect(page.locator("#speech-preset")).toHaveCount(0);
  await expect(page.locator("#speech-lip-mode")).toHaveCount(0);
  await expect(rows.nth(0).locator(".utterance-row-mode option[value=open]")).toHaveText("open");
  const choice = page.locator('[data-selected="true"]');
  await presetTrigger(choice).click();
  const optionNames = await choice.locator(".preset-picker-option span:nth-child(2)").allTextContents();
  const optionValues = await choice.locator(".preset-picker-option").evaluateAll(
    (nodes) => nodes.map((node) => node.getAttribute("data-preset-id")!));
  await presetTrigger(choice).click();
  expect(optionNames).toHaveLength(2);
  expect(optionNames[0]).not.toBe(optionNames[1]);

  await rows.nth(0).locator(".utterance-item-select").click();
  await choosePreset(page.locator('[data-selected="true"]'), optionValues[0]);
  await page.locator('[data-selected="true"] .utterance-row-mode select').selectOption("open");

  await rows.nth(1).locator(".utterance-item-select").click();
  await choosePreset(page.locator('[data-selected="true"]'), optionValues[1]);
  await expect(presetTrigger(rows.nth(0))).toHaveAttribute("data-selected-preset-id", optionValues[0]);
  await expect(presetTrigger(rows.nth(1))).toHaveAttribute("data-selected-preset-id", optionValues[1]);
  await expect(rows.nth(0).locator(".utterance-row-mode select")).toHaveValue("open");
  await expect(rows.nth(1).locator(".utterance-row-mode select")).toHaveValue("none");

  const originalIds = await rows.evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute("data-utterance-id")));
  await page.getByRole("button", { name: "上へ: 2 second.wav" }).click();
  await expect(rows.nth(0)).toHaveAttribute("data-utterance-id", originalIds[1]!);
  await expect(rows.nth(1)).toHaveAttribute("data-utterance-id", originalIds[0]!);
  await expect(presetTrigger(rows.nth(0))).toHaveAttribute("data-selected-preset-id", optionValues[1]);
  await expect(presetTrigger(rows.nth(1))).toHaveAttribute("data-selected-preset-id", optionValues[0]);
  await expect(rows.nth(1).locator(".utterance-row-mode select")).toHaveValue("open");

  // An individual edit is reflected in its own row, without changing other items.
  await rows.nth(1).locator(".utterance-item-select").click();
  await choosePreset(page.locator('[data-selected="true"]'), optionValues[1]);
  await expect(presetTrigger(rows.nth(1))).toHaveAttribute("data-selected-preset-id", optionValues[1]);
  await expect(presetTrigger(rows.nth(0))).toHaveAttribute("data-selected-preset-id", optionValues[1]);
  await expect(rows.nth(0).locator(".utterance-row-mode select")).toHaveValue("none");
  await expect(rows.nth(1).locator(".utterance-row-mode select")).toHaveValue("open");
  // A change made from an unselected row switches the selected WAV.
  await rows.nth(0).locator(".utterance-row-mode select").selectOption("open");
  await expect(rows.nth(0)).toHaveAttribute("data-selected", "true");
  await expect(rows.nth(1)).toHaveAttribute("data-selected", "false");
  await expect(rows.nth(0).locator(".utterance-row-mode select")).toHaveValue("open");
  await expect(rows.nth(1).locator(".utterance-row-mode select")).toHaveValue("open");
  await expect(page.getByRole("heading", { name: "選択中のWAV" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "書き出し", exact: true })).toBeVisible();
  await expect(page.locator(".utterance-list-toolbar").getByRole("button", {
    name: "選択中の設定を全件に適用",
  })).toBeVisible();
  const width = await page.evaluate(() => {
    const list = document.querySelector(".utterance-list-panel")!.getBoundingClientRect();
    const exportPanel = document.querySelector(".utterance-export-panel")!.getBoundingClientRect();
    return { list: list.width, export: exportPanel.width,
      left: Math.abs(list.left - exportPanel.left), vertical: exportPanel.top > list.bottom };
  });
  expect(Math.abs(width.list - width.export)).toBeLessThanOrEqual(2);
  expect(width.left).toBeLessThanOrEqual(2);
  expect(width.vertical).toBe(true);
});


test("desktop WAV headers align while expanded WAV rows use page scrolling", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.route("**/api/wav", (route) => route.fulfill({
    json: { samples: 800, sample_rate: 8000, duration_seconds: 0.1 },
  }));
  await openSpeech(page);
  const aligned = async () => page.evaluate(() => {
    const positions = (selector: string) =>
      document.querySelector(selector)!.getBoundingClientRect().left;
    return {
      preset: positions(".utterance-column-preset") - positions(".utterance-row-preset"),
      mode: positions(".utterance-column-mode") - positions(".utterance-row-mode"),
      scrollable: (() => {
        const list = document.querySelector(".utterance-items")!;
        return list.scrollHeight > list.clientHeight;
      })(),
    };
  });
  await addWav(page, "/tmp/first.wav");
  await expect(page.locator("[data-utterance-id]")).toHaveCount(1);
  let widths = await aligned();
  expect(widths.scrollable).toBe(false);
  expect(Math.abs(widths.preset)).toBeLessThanOrEqual(2);
  expect(Math.abs(widths.mode)).toBeLessThanOrEqual(2);
  for (let i = 2; i <= 9; i++) {
    await addWav(page, "/tmp/voice_" + i + ".wav");
  }
  await expect(page.locator("[data-utterance-id]")).toHaveCount(9);
  widths = await aligned();
  expect(widths.scrollable).toBe(false);
  expect(Math.abs(widths.preset)).toBeLessThanOrEqual(2);
  expect(Math.abs(widths.mode)).toBeLessThanOrEqual(2);
});

test("an edit in the same JS turn as starting batch export is rejected by the synchronous lock", async ({ page }) => {
  await page.route("**/api/wav", (route) => route.fulfill({
    json: { samples: 800, sample_rate: 8000, duration_seconds: 0.1 },
  }));
  await openSpeech(page);
  await addWav(page, "/tmp/first.wav");
  await addWav(page, "/tmp/second.wav");
  let releaseExport: (() => void) | undefined;
  let exportsStarted = 0;
  await page.route("**/api/preset-batch-mov-export", async (route) => {
    exportsStarted++;
    if (exportsStarted === 1) {
      await new Promise<void>((resolve) => { releaseExport = resolve; });
    }
    const payload = route.request().postDataJSON() as { basename: string };
    await route.fulfill({ json: {
      mov: "/tmp/output/" + payload.basename + ".mov",
      frames: 30, sample_count: 800, sample_rate: 8000,
    } });
  });
  const first = page.locator("[data-utterance-id]").first().locator(".utterance-row-mode select");
  const second = page.locator("[data-utterance-id]").nth(1).locator(".utterance-row-mode select");
  // Verify that a direct DOM change is a real React change event before trying the race.
  await first.evaluate((node) => {
    const el = node as HTMLSelectElement;
    el.value = "open";
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await expect(first).toHaveValue("open");
  await first.selectOption("none");
  await expect(first).toHaveValue("none");
  await page.locator("[data-utterance-id]").nth(1).locator(".utterance-item-select").click();

  await page.getByRole("radio", { name: /^全件/ }).check();
  await expect(page.getByRole("button", { name: "全件を書き出す" })).toBeEnabled();
  await page.evaluate(() => {
    const run = [...document.querySelectorAll("button")].find((button) =>
      button.textContent?.trim() === "全件を書き出す")!;
    // A synthetic event intentionally bypasses disabled UI, in the same JS turn.
    run.click();
    const select = document.querySelector(".utterance-row-mode select") as HTMLSelectElement;
    select.value = "open";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await expect.poll(() => Boolean(releaseExport)).toBe(true);
  await expect(first).toHaveValue("none");
  await expect(second).toHaveValue("none");
  await expect(page.locator("[data-utterance-id]").nth(1))
    .toHaveAttribute("data-selected", "true");
  await expect(page.locator(".utterance-row-mode select:disabled")).toHaveCount(2);
  releaseExport!();
  await expect(page.getByText("一括書き出し完了：MOV 2件／全体OTIO", { exact: false }))
    .toBeVisible();
});

test("preset verification failure is not displayed as a missing assigned preset", async ({ page }) => {
  await page.route("**/api/wav", (route) => route.fulfill({
    json: { samples: 800, sample_rate: 8000, duration_seconds: 0.1 },
  }));
  await openSpeech(page);
  await addWav(page, "/tmp/voice.wav");
  const preset = page.locator("[data-utterance-id] .utterance-row-preset .preset-picker-trigger");
  await expect(preset).toBeEnabled();

  await page.getByRole("button", { name: "プリセット", exact: true }).click();
  let release: (() => void) | undefined;
  await page.route("**/api/psd", async (route) => {
    await new Promise<void>((resolve) => { release = resolve; });
    await route.fulfill({ json: {
      width: 64, height: 64, fingerprint: "changed-source", preview: png, layers,
    } });
  });
  await page.getByRole("button", { name: "セリフ", exact: true }).click();
  await expect(preset).toBeDisabled();
  await expect(preset).toContainText("確認中…");
  await expect.poll(() => Boolean(release)).toBe(true);
  release!();
  await expect(page.getByRole("alert")).toContainText("PSDが変更");
  await expect(preset).toContainText("プリセットを確認できません");
  await expect(preset).toBeDisabled();
  await expect(page.getByRole("button", { name: "MOVを書き出す" })).toBeDisabled();
});


test("removing the selected-WAV panel retains row details, list bulk apply, and export warnings", async ({ page }) => {
  await page.route("**/api/wav", (route) => route.fulfill({
    json: { samples: 800, sample_rate: 8000, duration_seconds: 0.1 },
  }));
  await openSpeech(page);
  await addWav(page, "/tmp/first.wav");
  await addWav(page, "/tmp/second.wav");
  const list = page.locator(".utterance-list-panel");
  const exportPanel = page.locator(".utterance-export-panel");
  await expect(page.getByRole("heading", { name: "選択中のWAV" })).toHaveCount(0);
  await expect(exportPanel).toHaveCount(1);
  await expect(list.locator(".utterance-item")).toHaveCount(2);
  await expect(list.locator(".utterance-item").first()).toContainText("8000Hz");
  const apply = list.getByRole("button", { name: "選択中の設定を全件に適用" });
  await expect(apply).toBeEnabled();
  await expect(exportPanel.getByText("選択中のWAV：second.wav")).toBeVisible();
  await expect(exportPanel.locator("#speech-fps")).toHaveValue("30");
  await expect(exportPanel.locator("#speech-basename")).toHaveValue("002_character_second");

  // The only state change from bulk apply is preset/mode; each WAV retains save settings.
  await page.locator(".utterance-item").first().locator(".utterance-item-select").click();
  await page.locator("#speech-fps").selectOption("60");
  await page.locator("#speech-basename").fill("different_name");
  await page.locator(".utterance-item").nth(1).locator(".utterance-item-select").click();
  const dialog = page.waitForEvent("dialog").then(async (d) => {
    expect(d.message()).toContain("プリセットと口パク方式");
    await d.accept();
  });
  await apply.click();
  await dialog;
  await page.locator(".utterance-item").first().locator(".utterance-item-select").click();
  await expect(page.locator("#speech-fps")).toHaveValue("60");
  await expect(page.locator("#speech-basename")).toHaveValue("different_name");
  await expect(list.getByRole("button", { name: "選択中の設定を全件に適用" }))
    .toBeEnabled();

  // Mouth mappings are absent in this test fixture: warnings must still be visible.
  await list.locator(".utterance-item").first().locator(".utterance-row-mode select")
    .selectOption("open");
  await expect(exportPanel.getByText("開いた口のレイヤーを明示選択", { exact: false })).toBeVisible();
  await expect(exportPanel.getByRole("button", { name: "MOVを書き出す" }))
    .toBeDisabled();
});


test("batch naming shows exact preview and creates one combined OTIO for reordered utterances", async ({ page }) => {
  await page.route("**/api/wav", (route) => route.fulfill({
    json: { samples: 800, sample_rate: 8000, duration_seconds: 0.1 },
  }));
  await openSpeech(page);
  await addWav(page, "/tmp/e\u0301.wav");
  await addWav(page, "/tmp/あいさつ.wav");
  await expect(page.locator("[data-utterance-id]")).toHaveCount(2);
  await page.getByRole("button", { name: "上へ: 2 あいさつ.wav" }).click();
  await page.getByRole("radio", { name: /^全件/ }).check();
  await page.locator("#batch-project-name").fill("さよそみ動画");
  await page.locator("#batch-character-name").fill("あんこもん");
  await expect(page.locator(".export-plan-items li").first())
    .toContainText("001_あんこもん_あいさつ.mov");
  await expect(page.locator(".export-plan-items li").nth(1))
    .toContainText("002_あんこもん_e\u0301.mov");
  await expect(page.locator(".batch-timeline-plan"))
    .toContainText("さよそみ動画.otio");
  const order: string[] = [];
  let timelinePayload: { basename: string; entries: Array<{ basename: string }> } | undefined;
  await page.route("**/api/preset-batch-mov-export", (route) => {
    const body = route.request().postDataJSON() as { basename: string };
    order.push(body.basename);
    return route.fulfill({ json: {
      mov: "/tmp/output/" + body.basename + ".mov", frames: 30,
      sample_count: 800, sample_rate: 8000,
    } });
  });
  await page.route("**/api/preset-combined-otio", (route) => {
    timelinePayload = route.request().postDataJSON() as typeof timelinePayload;
    return route.fulfill({ json: {
      otio: "/tmp/output/" + timelinePayload!.basename + ".otio",
      entries: timelinePayload!.entries.length,
    } });
  });
  await page.getByRole("button", { name: "全件を書き出す" }).click();
  await expect(page.getByText("一括書き出し完了：MOV 2件／全体OTIO", { exact: false }))
    .toBeVisible();
  expect(order).toEqual(["001_あんこもん_あいさつ", "002_あんこもん_e\u0301"]);
  expect(timelinePayload?.basename).toBe("さよそみ動画");
  expect(timelinePayload?.entries.map((x) => x.basename)).toEqual(order);
});

test("existing combined OTIO is offered for a confirmed full-generation overwrite", async ({ page }) => {
  await page.route("**/api/wav", (route) => route.fulfill({ json: {
    samples: 800, sample_rate: 8000, duration_seconds: 0.1,
    source_identity: "1:2:3:4:5",
  } }));
  await openSpeech(page);
  await addWav(page, "/tmp/voice.wav");
  let renders = 0;
  await page.route("**/api/preset-batch-mov-export", (route) => {
    renders++;
    return route.fulfill({ status: 500, json: { detail: "must not be called" } });
  });
  await page.route("**/api/preset-combined-otio-destination", (route) =>
    route.fulfill({ json: { state: "complete", canonical_output_dir: "/tmp/output" } }));
  await page.route("**/api/preset-batch-mov-destination", (route) =>
    route.fulfill({ json: { state: "complete", canonical_output_dir: "/tmp/output" } }));
  await page.getByRole("radio", { name: /^全件/ }).check();
  await expect(page.locator(".batch-timeline-plan")).toContainText("上書き");
  await expect(page.locator(".export-plan-items")).toContainText("上書き");
  const dialog = page.waitForEvent("dialog").then(async (shown) => {
    expect(shown.message()).toContain("既存のMOV・全体OTIOを合計2件上書き");
    await shown.dismiss();
  });
  await page.getByRole("button", { name: "全件を書き出す" }).click();
  await dialog;
  await expect(page.getByText("一括書き出しをキャンセルしました")).toBeVisible();
  expect(renders).toBe(0);
});

test("batch alternate-name choice uses one shared suffix across MOVs and OTIO", async ({ page }) => {
  await page.route("**/api/wav", (route) => route.fulfill({ json: {
    samples: 800, sample_rate: 8000, duration_seconds: 0.1,
  } }));
  await openSpeech(page);
  await addWav(page, "/tmp/first.wav");
  await addWav(page, "/tmp/second.wav");
  await page.route("**/api/preset-batch-mov-destination", (route) => {
    const { basename } = route.request().postDataJSON() as { basename: string };
    return route.fulfill({ json: {
      state: basename.endsWith("_002") ? "available" : "complete",
      canonical_output_dir: "/tmp/output",
    } });
  });
  await page.route("**/api/preset-combined-otio-destination", (route) => {
    const { basename } = route.request().postDataJSON() as { basename: string };
    return route.fulfill({ json: {
      state: basename.endsWith("_002") ? "available" : "complete",
      canonical_output_dir: "/tmp/output",
    } });
  });
  await page.getByRole("radio", { name: /^全件/ }).check();
  await page.getByRole("radio", { name: /別名で保存/ }).check();
  await expect(page.locator(".export-plan-items")).toContainText("001_character_first_002.mov");
  await expect(page.locator(".export-plan-items")).toContainText("002_character_second_002.mov");
  await expect(page.locator(".batch-timeline-plan")).toContainText("project_002.otio");
  await expect(page.getByText("書き出し予定を確認済み（上書き 0 件）")).toBeVisible();
});



for (const sample of [
  {
    label: "180 UTF-8 bytes with Japanese and decomposed Unicode",
    source: ["あ".repeat(60), "e\u0301".repeat(60)],
    resolved: ["あ".repeat(58) + "_002", "e\u0301".repeat(58) + "_002"],
  },
  {
    label: "120 Unicode characters with ASCII",
    source: ["a".repeat(120), "b".repeat(120)],
    resolved: ["a".repeat(116) + "_002", "b".repeat(116) + "_002"],
  },
  {
    label: "mixed Japanese and NFD at the byte boundary",
    source: ["あ".repeat(58) + "e\u0301Z", "b".repeat(120)],
    resolved: ["あ".repeat(58) + "_002", "b".repeat(116) + "_002"],
  },
]) {
  test("batch rename respects " + sample.label + " for two MOVs and the combined OTIO",
    async ({ page }) => {
      await page.route("**/api/wav", (route) => route.fulfill({ json: {
        samples: 800, sample_rate: 8000, duration_seconds: 0.1,
      } }));
      await openSpeech(page);
      await page.locator("#batch-mov-template").fill("{WAV名}");
      const checked: Array<{ basenames: string[]; timeline_basename: string }> = [];
      await page.route("**/api/preset-batch-check-names", (route) => {
        const body = route.request().postDataJSON() as {
          basenames: string[]; timeline_basename: string;
        };
        const names = [...body.basenames, body.timeline_basename];
        if (names.some((name) => [...name].length > 120 ||
            new TextEncoder().encode(name).length > 180)) {
          return route.fulfill({ status: 422, json: { detail: "Filename exceeds API limit" } });
        }
        checked.push(body);
        return route.fulfill({ json: { valid: true } });
      });
      for (const basename of sample.source) await addWav(page, "/tmp/" + basename + ".wav");
      await expect(page.locator("[data-utterance-id]")).toHaveCount(2);
      await page.route("**/api/preset-batch-mov-destination", (route) => {
        const body = route.request().postDataJSON() as { basename: string };
        return route.fulfill({ json: {
          state: body.basename.endsWith("_002") ? "available" : "complete",
          canonical_output_dir: "/tmp/output",
        } });
      });
      await page.route("**/api/preset-combined-otio-destination", (route) => {
        const body = route.request().postDataJSON() as { basename: string };
        return route.fulfill({ json: {
          state: body.basename.endsWith("_002") ? "available" : "complete",
          canonical_output_dir: "/tmp/output",
        } });
      });
      let startPayload: {
        timeline_basename: string; entries: Array<{ basename: string }>
      } | undefined;
      await page.route("**/api/preset-batch-start", (route) => {
        startPayload = route.request().postDataJSON() as typeof startPayload;
        return route.fulfill({ json: { batch_id: "suffix-session" } });
      });
      let timelinePayload: {
        basename: string; entries: Array<{ basename: string }>
      } | undefined;
      await page.route("**/api/preset-combined-otio", (route) => {
        timelinePayload = route.request().postDataJSON() as typeof timelinePayload;
        return route.fulfill({ json: {
          otio: "/tmp/output/" + timelinePayload!.basename + ".otio",
          entries: timelinePayload!.entries.length,
        } });
      });
      await page.getByRole("radio", { name: /^全件/ }).check();
      await page.getByRole("radio", { name: /別名で保存/ }).check();
      for (const [index, basename] of sample.resolved.entries()) {
        await expect(page.locator(".export-plan-items li").nth(index))
          .toContainText(basename + ".mov");
      }
      await expect(page.locator(".batch-timeline-plan")).toContainText("project_002.otio");
      await expect(page.getByText("書き出し予定を確認済み（上書き 0 件）")).toBeVisible();
      expect(checked.some((body) =>
        body.timeline_basename === "project_002" &&
        JSON.stringify(body.basenames) === JSON.stringify(sample.resolved))).toBe(true);
      await page.getByRole("button", { name: "全件を書き出す" }).click();
      await expect(page.getByText("一括書き出し完了：MOV 2件／全体OTIO", { exact: false }))
        .toBeVisible();
      expect(startPayload?.timeline_basename).toBe("project_002");
      expect(startPayload?.entries.map((entry) => entry.basename)).toEqual(sample.resolved);
      expect(timelinePayload?.basename).toBe("project_002");
      expect(timelinePayload?.entries.map((entry) => entry.basename)).toEqual(sample.resolved);
    });
}

test("batch rename fails closed when different raw names collapse after truncation",
  async ({ page }) => {
    await page.route("**/api/wav", (route) => route.fulfill({ json: {
      samples: 800, sample_rate: 8000, duration_seconds: 0.1,
    } }));
    await openSpeech(page);
    await page.locator("#batch-mov-template").fill("{WAV名}");
    await addWav(page, "/tmp/" + "a".repeat(119) + "X.wav");
    await addWav(page, "/tmp/" + "a".repeat(119) + "Y.wav");
    await page.route("**/api/preset-batch-mov-destination", (route) =>
      route.fulfill({ json: { state: "complete", canonical_output_dir: "/tmp/output" } }));
    await page.route("**/api/preset-combined-otio-destination", (route) =>
      route.fulfill({ json: { state: "complete", canonical_output_dir: "/tmp/output" } }));
    await page.getByRole("radio", { name: /^全件/ }).check();
    await page.getByRole("radio", { name: /別名で保存/ }).check();
    await expect(page.getByText("MOVの保存名が重複します（別名の短縮後）", { exact: false }))
      .toBeVisible();
    await expect(page.getByRole("button", { name: "全件を書き出す" })).toBeDisabled();
  });

test("LAB status is shown per WAV without enabling unimplemented aiueo export", async ({ page }) => {
  await page.route("**/api/wav", (route) => route.fulfill({
    json: { samples: 1000, sample_rate: 1000, duration_seconds: 1,
      source_identity: "1:2:3:4:5" },
  }));
  const requests: string[] = [];
  await page.route("**/api/wav-lab", (route) => {
    const { path, source_identity } = route.request().postDataJSON() as {
      path: string; source_identity: string;
    };
    expect(source_identity).toBe("1:2:3:4:5");
    requests.push(path);
    if (path.endsWith("ok.wav"))
      return route.fulfill({ json: { status: "valid", reason: null,
        source_identity: "1:2:3:4:5" } });
    if (path.endsWith("missing.wav"))
      return route.fulfill({ json: { status: "missing", reason: null } });
    return route.fulfill({ json: { status: "invalid", reason: "unsupported phoneme" } });
  });
  await openSpeech(page);
  await addWav(page, "/tmp/ok.wav");
  await addWav(page, "/tmp/missing.wav");
  await addWav(page, "/tmp/bad.wav");
  const rows = page.locator("[data-utterance-id]");
  await expect(rows.nth(0).locator('[data-lab-status="valid"]')).toContainText("LAB: 有効");
  await expect(rows.nth(1).locator('[data-lab-status="missing"]')).toContainText("LAB: なし");
  await expect(rows.nth(2).locator('[data-lab-status="invalid"]')).toContainText("LAB: 不正");
  await expect(rows.nth(2).locator('[data-lab-status="invalid"]')).toHaveAttribute(
    "title", "unsupported phoneme");
  expect(new Set(requests)).toEqual(new Set(["/tmp/ok.wav", "/tmp/missing.wav", "/tmp/bad.wav"]));
  await expect(rows.nth(0).locator(".utterance-row-mode option")).toHaveCount(3);
  await rows.nth(0).locator(".utterance-item-select").click();
  await expect(rows.nth(0).locator('[data-lab-status="valid"]')).toBeVisible();
});


test("aiueo requires valid LAB and all six preset shapes before export", async ({ page }) => {
  await page.route("**/api/wav", (route) => route.fulfill({
    json: { samples: 1000, sample_rate: 1000, duration_seconds: 1,
      source_identity: "1:2:3:4:5" },
  }));
  await page.route("**/api/wav-lab", (route) => {
    const { path } = route.request().postDataJSON() as { path: string };
    return route.fulfill({ json: path.endsWith("good.wav")
      ? { status: "valid", reason: null, source_identity: "1:2:3:4:5" }
      : { status: "missing", reason: null, source_identity: null } });
  });
  await openSpeech(page);
  await addWav(page, "/tmp/good.wav");
  await expect(page.locator('[data-lab-status="valid"]')).toBeVisible();
  await page.locator('[data-selected="true"] .utterance-row-mode select').selectOption("aiueo");
  await expect(page.locator('[data-selected="true"] .utterance-row-mode select')).toHaveValue("aiueo");
  await expect(page.getByText("6口形すべてを明示選択してください。", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "MOVを書き出す" })).toBeDisabled();
  await addWav(page, "/tmp/missing.wav");
  await expect(page.locator('[data-selected="true"] [data-lab-status="missing"]')).toBeVisible();
  await expect(page.locator('[data-selected="true"] .utterance-row-mode option[value="aiueo"]'))
    .toHaveAttribute("disabled", "");
  await page.locator('[data-utterance-id]').first().locator(".utterance-item-select").click();
  await expect(page.locator('[data-selected="true"] .utterance-row-mode select')).toHaveValue("aiueo");
});


test("batch manifest and actual MOV requests agree for valid LAB none/open/aiueo/disabled", async ({ page }) => {
  await page.route("**/api/wav", (route) => route.fulfill({ json: {
    samples: 800, sample_rate: 8000, duration_seconds: 0.1,
    source_identity: "1:2:3:4:5",
  } }));
  await page.route("**/api/wav-lab", (route) => route.fulfill({ json: {
    status: "valid", reason: null, source_identity: "9:8:7:6:5",
  } }));
  await openSpeech(page);
  // Supply a valid saved character setup with both open and all six aiueo
  // shapes; this exercises the real React hook, not two calls to exportPayload.
  await page.evaluate(() => {
    const key = "tachie-motion.preset-draft.v2";
    const value = localStorage.getItem(key);
    if (!value) throw new Error("Missing preset draft");
    const draft = JSON.parse(value) as {
      collection: { items: Array<Record<string, unknown>>;
        motionGroups?: { mouth: string[] } };
    };
    const preset = draft.collection.items[0];
    if (!preset) throw new Error("Missing default preset");
    preset.openMouth = {
      closed: [{ path: "0/0", visible: true }],
      opened: [{ path: "0/0", visible: true }],
    };
    preset.aiueoMouth = Object.fromEntries(["a", "i", "u", "e", "o", "n"].map((name) =>
      [name, [{ path: "0/0", visible: true }]]));
    draft.collection.motionGroups = { mouth: ["0"] };
    draft.collection.items.push({ ...structuredClone(preset), id: "mouth-off",
      name: "口パクOFF", mouthMotionEnabled: false });
    localStorage.setItem(key, JSON.stringify(draft));
  });
  await page.getByRole("button", { name: "プリセット", exact: true }).click();
  await page.getByRole("button", { name: "セリフ", exact: true }).click();
  await expect(page.locator(".utterance-list-panel")).toBeVisible();
  for (const name of ["none", "open", "aiueo", "disabled"]) {
    await addWav(page, "/tmp/" + name + ".wav");
  }
  const rows = page.locator("[data-utterance-id]");
  await expect(rows).toHaveCount(4);
  await expect(rows.locator('[data-lab-status="valid"]')).toHaveCount(4);
  await rows.nth(1).locator(".utterance-row-mode select").selectOption("open");
  await rows.nth(2).locator(".utterance-row-mode select").selectOption("aiueo");
  await rows.nth(3).locator(".utterance-row-mode select").selectOption("aiueo");
  await choosePreset(rows.nth(3), "mouth-off");

  type Entry = { basename: string; wav: string; lab_source_identity: string | null };
  type Movie = Entry & { mode: string; batch_index: number };
  const manifests: Entry[][] = [];
  const requests: Movie[] = [];
  await page.route("**/api/preset-batch-start", (route) => {
    const body = route.request().postDataJSON() as { entries: Entry[] };
    manifests.push(body.entries);
    return route.fulfill({ json: { batch_id: "mixed-modes" } });
  });
  await page.route("**/api/preset-batch-mov-export", (route) => {
    const body = route.request().postDataJSON() as Movie;
    requests.push(body);
    return route.fulfill({ json: {
      mov: "/tmp/output/" + body.basename + ".mov",
      frames: 3, sample_count: 800, sample_rate: 8000,
    } });
  });
  await page.getByRole("radio", { name: /^全件/ }).check();
  await expect(page.locator(".export-plan-items li")).toHaveCount(4);
  await page.getByRole("button", { name: "全件を書き出す" }).click();
  await expect(page.getByText("一括書き出し完了：MOV 4件／全体OTIO", { exact: false }))
    .toBeVisible();

  expect(manifests).toHaveLength(1);
  expect(requests).toHaveLength(4);
  expect(manifests[0].map((entry) => entry.lab_source_identity))
    .toEqual([null, null, "9:8:7:6:5", null]);
  expect(requests.map((entry) => entry.mode)).toEqual(["none", "open", "aiueo", "none"]);
  for (const [index, entry] of manifests[0].entries()) {
    expect(requests[index].batch_index).toBe(index);
    expect(requests[index].basename).toBe(entry.basename);
    expect(requests[index].wav).toBe(entry.wav);
    expect(requests[index].lab_source_identity).toBe(entry.lab_source_identity);
  }
});


test("manual LAB recheck replaces a stale valid result without changing the WAV registration", async ({ page }) => {
  await page.route("**/api/wav", (route) => route.fulfill({ json: {
    samples: 1000, sample_rate: 1000, duration_seconds: 1,
    source_identity: "1:2:3:4:5",
  } }));
  let status: "valid" | "missing" = "valid";
  let requests = 0;
  await page.route("**/api/wav-lab", (route) => {
    requests++;
    return route.fulfill({ json: status === "valid"
      ? { status: "valid", reason: null, source_identity: "9:8:7:6:5" }
      : { status: "missing", reason: null, source_identity: null } });
  });
  await openSpeech(page);
  await addWav(page, "/tmp/external-lab-change.wav");
  const row = page.locator("[data-utterance-id]").first();
  const id = await row.getAttribute("data-utterance-id");
  await expect(row.locator('[data-lab-status="valid"]')).toBeVisible();
  status = "missing";
  await page.getByRole("button", { name: "LABを再確認" }).click();
  await expect(row.locator('[data-lab-status="missing"]')).toBeVisible();
  await expect(row.locator('.utterance-row-mode option[value="aiueo"]'))
    .toHaveAttribute("disabled", "");
  expect(await row.getAttribute("data-utterance-id")).toBe(id);
  expect(requests).toBeGreaterThanOrEqual(2);
});


test("foreign OTIO blocks MOV overwrite in preview but permits whole-batch rename", async ({ page }) => {
  await page.route("**/api/wav", (route) => route.fulfill({ json: {
    samples: 800, sample_rate: 8000, duration_seconds: 0.1,
  } }));
  await openSpeech(page);
  await addWav(page, "/tmp/mix.wav");
  await page.route("**/api/preset-batch-mov-destination", (route) => {
    const body = route.request().postDataJSON() as { basename: string };
    return route.fulfill({ json: {
      state: body.basename.endsWith("_002") ? "available" : "complete",
      canonical_output_dir: "/tmp/output",
    } });
  });
  await page.route("**/api/preset-combined-otio-destination", (route) => {
    const body = route.request().postDataJSON() as { basename: string };
    return route.fulfill({ json: {
      state: body.basename.endsWith("_002") ? "available" : "complete",
      canonical_output_dir: "/tmp/output", other_otio_present: true,
    } });
  });
  let starts = 0;
  await page.route("**/api/preset-batch-start", (route) => {
    starts++;
    return route.fulfill({ status: 500, json: { detail: "should not start" } });
  });
  await page.getByRole("radio", { name: /^全件/ }).check();
  await expect(page.getByRole("alert")).toContainText("別のOTIOが同じフォルダにあります");
  await expect(page.getByRole("alert")).toContainText("別名で保存");
  await expect(page.getByRole("button", { name: "全件を書き出す" })).toBeDisabled();
  expect(starts).toBe(0);
  await page.getByRole("radio", { name: "別名で保存（_002などを自動追加）" }).check();
  await expect(page.locator(".export-plan-items")).toContainText("_002.mov");
  await expect(page.locator(".batch-timeline-plan")).toContainText("_002.otio");
  await expect(page.getByRole("button", { name: "全件を書き出す" })).toBeEnabled();
});

test("a foreign OTIO appearing after preview is rechecked before batch start", async ({ page }) => {
  await page.route("**/api/wav", (route) => route.fulfill({ json: {
    samples: 800, sample_rate: 8000, duration_seconds: 0.1,
  } }));
  await openSpeech(page);
  await addWav(page, "/tmp/mix.wav");
  await page.route("**/api/preset-batch-mov-destination", (route) => route.fulfill({
    json: { state: "complete", canonical_output_dir: "/tmp/output" },
  }));
  let foreign = false;
  await page.route("**/api/preset-combined-otio-destination", (route) =>
    route.fulfill({ json: {
      state: "complete", canonical_output_dir: "/tmp/output",
      other_otio_present: foreign,
    } }));
  let starts = 0;
  await page.route("**/api/preset-batch-start", (route) => {
    starts++;
    return route.fulfill({ status: 500, json: { detail: "unexpected start" } });
  });
  await page.getByRole("radio", { name: /^全件/ }).check();
  await expect(page.getByText("書き出し予定を確認済み", { exact: false })).toBeVisible();
  foreign = true;
  await page.getByRole("button", { name: "全件を書き出す" }).click();
  await expect(page.getByRole("status")
    .filter({ hasText: "一括書き出しを完了できませんでした" }))
    .toContainText("別のOTIOが同じフォルダにあります");
  expect(starts).toBe(0);
});

function waveformTestWav(amplitude: number): Buffer {
  const samples = 16000;
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write("RIFF", 0); wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write("data", 36); wav.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) {
    const sample = i < samples / 2 ? 0 :
      Math.round(amplitude * Math.sin(i * Math.PI / 20));
    wav.writeInt16LE(sample, 44 + i * 2);
  }
  return wav;
}

test("WAV waveform seeks and drops old peaks after switching sources", async ({ page }) => {
  await page.route("**/api/wav", (route) => route.fulfill({
    json: { samples: 16000, sample_rate: 8000, duration_seconds: 2 },
  }));
  const requests: string[] = [];
  await page.route("**/api/wav-playback", (route) => {
    const path = (route.request().postDataJSON() as { path: string }).path;
    requests.push(path);
    return route.fulfill({ body: waveformTestWav(path.endsWith("one.wav") ? 16000 : 0),
      contentType: "audio/wav" });
  });
  await openSpeech(page);
  await addWav(page, "/tmp/one.wav");
  await addWav(page, "/tmp/two.wav");
  const rows = page.locator("[data-utterance-id]");
  await rows.nth(0).locator(".utterance-item-play").click();
  const first = rows.nth(0).locator(".wav-waveform");
  await expect(first.locator("path")).toHaveAttribute("d", /^M/);
  const firstWave = await first.locator("path").getAttribute("d");
  const bounds = await first.boundingBox();
  expect(bounds).not.toBeNull();
  await first.click({ position: { x: bounds!.width * 0.7, y: bounds!.height / 2 } });
  const audio = page.locator(".utterance-playback audio");
  await expect.poll(() => audio.evaluate((el) => (el as HTMLAudioElement).currentTime))
    .toBeGreaterThan(1);
  await rows.nth(1).locator(".utterance-item-play").click();
  await expect(first).toHaveCount(0);
  const second = rows.nth(1).locator(".wav-waveform");
  await expect(second.locator("path")).toHaveAttribute("d", /^M/);
  expect(await second.locator("path").getAttribute("d")).not.toBe(firstWave);
  expect(requests).toContain("/tmp/one.wav");
  expect(requests).toContain("/tmp/two.wav");
});

test("unavailable waveform decoder preserves native WAV seek slider", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "AudioContext", { value: undefined, configurable: true });
  });
  await page.route("**/api/wav", (route) => route.fulfill({
    json: { samples: 16000, sample_rate: 8000, duration_seconds: 2 },
  }));
  await page.route("**/api/wav-playback", (route) =>
    route.fulfill({ body: waveformTestWav(8000), contentType: "audio/wav" }));
  await openSpeech(page);
  await addWav(page, "/tmp/fallback.wav");
  await page.locator(".utterance-item-play").click();
  const slider = page.getByRole("slider", { name: "再生位置: fallback.wav" });
  await expect(slider).toBeVisible();
  await expect(page.locator(".wav-waveform")).toHaveCount(0);
  const bounds = await slider.boundingBox();
  expect(bounds).not.toBeNull();
  await slider.click({ position: { x: bounds!.width * 0.7, y: bounds!.height / 2 } });
  await expect.poll(() => page.locator(".utterance-playback audio")
    .evaluate((el) => (el as HTMLAudioElement).currentTime)).toBeGreaterThan(1);
});


test("waveform decodes one WAV at a time and cancels queued stale generations", async ({ page }) => {
  await page.addInitScript(() => {
    type WaveTrace = {
      created: number; closed: number; active: number; maxActive: number;
      rates: number[]; releases: Array<() => void>;
    };
    const trace: WaveTrace = {
      created: 0, closed: 0, active: 0, maxActive: 0, rates: [], releases: [],
    };
    (window as Window & { __waveformTrace?: WaveTrace }).__waveformTrace = trace;
    class DelayedAudioContext {
      sampleRate: number;
      constructor(options?: AudioContextOptions) {
        this.sampleRate = options?.sampleRate ?? 48000;
        trace.created++;
        trace.rates.push(this.sampleRate);
      }
      decodeAudioData(): Promise<AudioBuffer> {
        trace.active++;
        trace.maxActive = Math.max(trace.active, trace.maxActive);
        return new Promise<AudioBuffer>((resolve) => {
          trace.releases.push(() => {
            trace.active--;
            const channel = new Float32Array(1800).fill(0.5);
            resolve({
              length: channel.length, numberOfChannels: 1,
              getChannelData: () => channel,
            } as AudioBuffer);
          });
        });
      }
      close(): Promise<void> {
        trace.closed++;
        return Promise.resolve();
      }
    }
    Object.defineProperty(window, "AudioContext", {
      configurable: true, value: DelayedAudioContext,
    });
  });
  await page.route("**/api/wav", (route) => route.fulfill({
    json: { samples: 16000, sample_rate: 8000, duration_seconds: 2 },
  }));
  await page.route("**/api/wav-playback", (route) =>
    route.fulfill({ body: waveformTestWav(16000), contentType: "audio/wav" }));
  await openSpeech(page);
  for (const name of ["first", "second", "third"]) await addWav(page, "/tmp/" + name + ".wav");
  const row = page.locator("[data-utterance-id]");
  await row.nth(0).locator(".utterance-item-play").click();
  const stats = () => page.evaluate(() => {
    const trace = (window as Window & { __waveformTrace: {
      created: number; closed: number; active: number; maxActive: number; rates: number[];
      releases: Array<() => void>;
    } }).__waveformTrace;
    return { created: trace.created, closed: trace.closed,
      active: trace.active, maxActive: trace.maxActive,
      rates: trace.rates, waiting: trace.releases.length };
  });
  await expect.poll(async () => (await stats()).created).toBe(1);
  await row.nth(1).locator(".utterance-item-play").click();
  await row.nth(2).locator(".utterance-item-play").click();
  await expect.poll(async () => (await stats()).closed).toBeGreaterThanOrEqual(1);
  expect((await stats()).created).toBe(1); // queued second/third cannot overlap the first
  await page.evaluate(() => {
    const trace = (window as Window & { __waveformTrace: {
      releases: Array<() => void>;
    } }).__waveformTrace;
    trace.releases.shift()?.();
  });
  await expect.poll(async () => (await stats()).created).toBe(2);
  await page.evaluate(() => {
    const trace = (window as Window & { __waveformTrace: {
      releases: Array<() => void>;
    } }).__waveformTrace;
    trace.releases.shift()?.();
  });
  await expect(row.nth(2).locator(".wav-waveform")).toBeVisible();
  await expect(row.nth(0).locator(".wav-waveform")).toHaveCount(0);
  await expect(row.nth(1).locator(".wav-waveform")).toHaveCount(0);
  const final = await stats();
  expect(final.maxActive).toBe(1);
  expect(final.rates).toEqual([8000, 8000]); // never upsample to default 48 kHz
  await page.getByRole("button", { name: "停止", exact: true }).click();
  // The selected WAV remains editable after playback stops.
  await expect(row.nth(2).locator(".preset-change-editor")).toBeVisible();
});

test("PCM memory estimate skips a small compressed-byte WAV before AudioContext allocation", async ({ page }) => {
  await page.addInitScript(() => {
    (window as Window & { __waveContextCount?: number }).__waveContextCount = 0;
    class CountAudioContext {
      constructor() {
        (window as Window & { __waveContextCount: number }).__waveContextCount++;
      }
    }
    Object.defineProperty(window, "AudioContext", {
      configurable: true, value: CountAudioContext,
    });
  });
  // 7 MiB 8-bit mono PCM would allocate ~28 MiB of decoded Float32 data;
  // it is under the 16 MiB Blob cap, but above the 24 MiB PCM cap.
  const samples = 7 * 1024 * 1024;
  const wav = Buffer.alloc(44 + samples, 128);
  wav.write("RIFF", 0); wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(8000, 28);
  wav.writeUInt16LE(1, 32); wav.writeUInt16LE(8, 34);
  wav.write("data", 36); wav.writeUInt32LE(samples, 40);
  await page.route("**/api/wav", (route) => route.fulfill({
    json: { samples, sample_rate: 8000, duration_seconds: samples / 8000 },
  }));
  await page.route("**/api/wav-playback", (route) =>
    route.fulfill({ body: wav, contentType: "audio/wav" }));
  await openSpeech(page);
  await addWav(page, "/tmp/large8bit.wav");
  await page.locator(".utterance-item-play").click();
  await expect(page.getByRole("slider", { name: "再生位置: large8bit.wav" })).toBeVisible();
  await expect(page.locator(".wav-waveform")).toHaveCount(0);
  expect(await page.evaluate(() =>
    (window as Window & { __waveContextCount: number }).__waveContextCount)).toBe(0);
});

test("preset change points stay independent per WAV and reach the solo render payload", async ({ page }) => {
  await page.route("**/api/wav", (route) => route.fulfill({ json: {
    samples: 1000, sample_rate: 1000, duration_seconds: 1,
    source_identity: "1:2:3:4:5",
  } }));
  const requests: Array<Record<string, unknown>> = [];
  await page.route("**/api/preset-utterance-export", (route) => {
    requests.push(route.request().postDataJSON() as Record<string, unknown>);
    return route.fulfill({ json: {
      mov: "/tmp/output/timeline.mov", frames: 30, sample_count: 1000,
    } });
  });
  await openSpeech(page);
  await addWav(page, "/tmp/first.wav");
  await addWav(page, "/tmp/second.wav");
  const rows = page.locator("[data-utterance-id]");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(1)).toHaveAttribute("data-selected", "true");
  let editor = page.locator(".preset-change-editor");
  const add = () => editor.getByRole("button", { name: /編集点を追加/ });
  // One waveform/slider and directly editable rows, not a second add form.
  await expect(editor.locator(".preset-change-add")).toHaveCount(0);
  await expect(editor.locator(".preset-change-initial")).toHaveCount(0);
  await editor.getByRole("slider", { name: /再生位置/ }).press("ArrowRight");
  await add().click();
  await expect(editor.locator(".preset-change-points li")).toHaveCount(1);
  const time = editor.getByRole("spinbutton", { name: "編集点の時刻（秒）" });
  await time.fill("0.3");
  await time.press("Enter");
  await expect(editor.locator('[data-edit-point="300"]')).toHaveCount(1);
  await expect(add()).toBeDisabled(); // No duplicate at the same sample.

  await rows.first().locator(".utterance-item-select").click();
  editor = page.locator(".preset-change-editor");
  await expect(editor.locator(".preset-change-points li")).toHaveCount(0);
  await editor.getByRole("slider", { name: /再生位置/ }).press("ArrowRight");
  await add().click();
  const firstTime = editor.getByRole("spinbutton", { name: "編集点の時刻（秒）" });
  await firstTime.fill("0.2");
  await firstTime.press("Enter");
  await expect(editor.locator('[data-edit-point="200"]')).toHaveCount(1);

  await rows.nth(1).locator(".utterance-item-select").click();
  editor = page.locator(".preset-change-editor");
  const secondTime = editor.getByRole("spinbutton", { name: "編集点の時刻（秒）" });
  await expect(secondTime).toHaveValue("0.3");
  await secondTime.fill("0.4");
  await secondTime.press("Enter");
  await expect(editor.locator('[data-edit-point="400"]')).toHaveCount(1);

  await page.getByRole("button", { name: "MOVを書き出す" }).click();
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0].wav).toBe("/tmp/second.wav");
  expect(requests[0].timeline_changes).toMatchObject([
    { sample: 400, mode: "none", preset_id: expect.any(String) },
  ]);
  await page.getByRole("button", { name: "編集画面に戻る" }).click();
  await rows.first().locator(".utterance-item-select").click();
  editor = page.locator(".preset-change-editor");
  await expect(editor.locator('[data-edit-point="200"]')).toHaveCount(1);
  await editor.getByRole("button", { name: "編集点を削除" }).click();
  await expect(editor.locator(".preset-change-points li")).toHaveCount(0);
});

test("change points stay editable through slider when audio waveform is unavailable", async ({ page }) => {
  await page.route("**/api/wav", (route) => route.fulfill({ json: {
    samples: 800, sample_rate: 8000, duration_seconds: 0.1,
    source_identity: "1:2:3:4:5",
  } }));
  await page.route("**/api/wav-playback", (route) =>
    route.fulfill({ status: 404, json: { detail: "unavailable" } }));
  await openSpeech(page);
  await addWav(page, "/tmp/no-waveform.wav");
  const editor = page.locator(".preset-change-editor");
  await expect(editor.locator(".wav-waveform")).toHaveCount(0);
  const slider = editor.getByRole("slider", { name: /再生位置/ });
  await slider.focus();
  for (let step = 0; step < 5; step++) await slider.press("ArrowRight");
  await editor.getByRole("button", { name: /編集点を追加/ }).click();
  await expect(editor.locator('[data-edit-point="400"]')).toHaveCount(1);
  await expect(editor.locator(".preset-change-marker")).toHaveCount(0);
  const percentage = editor.getByRole("spinbutton", { name: "編集点の位置（%）" });
  await percentage.fill("75");
  await percentage.press("Enter");
  await expect(editor.locator('[data-edit-point="600"]')).toHaveCount(1);
  await expect(editor.locator(".wav-waveform")).toHaveCount(0);
});

test("Escape cancels both edit-point fields before blur can commit", async ({ page }) => {
  await page.route("**/api/wav", (route) => route.fulfill({ json: {
    samples: 1000, sample_rate: 1000, duration_seconds: 1,
  } }));
  await openSpeech(page);
  await addWav(page, "/tmp/cancel.wav");
  const editor = page.locator(".preset-change-editor");
  await editor.getByRole("slider", { name: /再生位置/ }).press("ArrowRight");
  await editor.getByRole("button", { name: /編集点を追加/ }).click();
  const row = editor.locator(".preset-change-point");
  const initial = Number(await row.getAttribute("data-edit-point"));
  expect(initial).toBeGreaterThan(0);
  const seconds = editor.getByRole("spinbutton", { name: "編集点の時刻（秒）" });
  const percent = editor.getByRole("spinbutton", { name: "編集点の位置（%）" });
  const originalSeconds = await seconds.inputValue();
  const originalPercent = await percent.inputValue();

  await seconds.fill("0.7");
  await seconds.press("Escape");
  await expect(row).toHaveAttribute("data-edit-point", String(initial));
  await expect(seconds).toHaveValue(originalSeconds);
  await expect(percent).toHaveValue(originalPercent);
  await seconds.fill("-3");
  await seconds.press("Escape");
  await expect(row).toHaveAttribute("data-edit-point", String(initial));

  await percent.fill("80");
  await percent.press("Escape");
  await expect(row).toHaveAttribute("data-edit-point", String(initial));
  await expect(percent).toHaveValue(originalPercent);
  await percent.fill("100");
  await percent.press("Escape");
  await expect(row).toHaveAttribute("data-edit-point", String(initial));

  await seconds.fill("0.6");
  await seconds.press("Enter");
  await expect(editor.locator('[data-edit-point="600"]')).toHaveCount(1);
  await percent.fill("70");
  await percent.press("Tab");
  await expect(editor.locator('[data-edit-point="700"]')).toHaveCount(1);
});

test("a preset used by an initial WAV or edit point cannot be deleted", async ({ page }) => {
  await page.route("**/api/wav", (route) => route.fulfill({ json: {
    samples: 1000, sample_rate: 1000, duration_seconds: 1,
  } }));
  await openSpeech(page);
  await addWav(page, "/tmp/first.wav");
  const first = page.locator("[data-utterance-id]").first();
  const initialId = await presetTrigger(first).getAttribute("data-selected-preset-id");
  expect(initialId).toBeTruthy();

  await page.getByRole("button", { name: "プリセット", exact: true }).click();
  await page.getByRole("button", { name: "＋ 作成" }).click();
  await page.getByRole("button", { name: "← 一覧へ" }).click();
  const card = page.locator(".preset-card").filter({ hasText: "新しいプリセット" });
  const addedId = await card.getAttribute("data-preset-id");
  expect(addedId).toBeTruthy();
  await page.getByRole("button", { name: "セリフ", exact: true }).click();

  await addWav(page, "/tmp/second.wav");
  const second = page.locator("[data-utterance-id]").nth(1);
  await choosePreset(second, addedId!); // Referenced as an initial WAV preset.
  await first.locator(".utterance-item-select").click();
  const editor = first.locator(".preset-change-editor");
  await editor.getByRole("slider", { name: /再生位置/ }).press("ArrowRight");
  await editor.getByRole("button", { name: /編集点を追加/ }).click();
  await editor.locator(".preset-change-point .preset-picker-trigger").click();
  await editor.locator(`.preset-change-point .preset-picker-option[data-preset-id="${addedId}"]`).click();
  await expect(editor.locator(".preset-change-point .preset-picker-trigger"))
    .toHaveAttribute("data-selected-preset-id", addedId!);

  await page.getByRole("button", { name: "プリセット", exact: true }).click();
  await card.getByRole("button", { name: "削除", exact: true }).click();
  const alert = page.getByRole("alert").filter({ hasText: "使用中" });
  await expect(alert).toContainText("WAV 2件");
  await expect(alert).toContainText("first.wav");
  await expect(alert).toContainText("second.wav");
  await expect(card).toHaveCount(1);

  // Only the explicit assignments are changed; all other WAV data survives.
  await page.getByRole("button", { name: "エラーを閉じる" }).click();
  await page.getByRole("button", { name: "セリフ", exact: true }).click();
  await choosePreset(second, initialId!);
  await page.getByRole("button", { name: "プリセット", exact: true }).click();
  await card.getByRole("button", { name: "削除", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "使用中" }))
    .toContainText("WAV 1件");
  await expect(card).toHaveCount(1); // The remaining edit point alone protects B.
  await page.getByRole("button", { name: "エラーを閉じる" }).click();
  await page.getByRole("button", { name: "セリフ", exact: true }).click();
  await first.locator(".utterance-item-select").click();
  await editor.getByRole("button", { name: "編集点を削除" }).click();
  await expect(editor.locator(".preset-change-point")).toHaveCount(0);
  await page.getByRole("button", { name: "プリセット", exact: true }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await card.getByRole("button", { name: "削除", exact: true }).click();
  await expect(card).toHaveCount(0);
  await page.getByRole("button", { name: "セリフ", exact: true }).click();
  await expect(presetTrigger(first)).toHaveAttribute("data-selected-preset-id", initialId!);
  await expect(presetTrigger(second)).toHaveAttribute("data-selected-preset-id", initialId!);
});

test("pending WAV inspection blocks preset deletion across screens until its row is committed", async ({ page }) => {
  let releaseInspection: (() => void) | undefined;
  await page.route("**/api/wav", async (route) => {
    await new Promise<void>((resolve) => { releaseInspection = resolve; });
    await route.fulfill({ json: {
      samples: 1000, sample_rate: 1000, duration_seconds: 1,
    } });
  });
  await openSpeech(page);
  await addWav(page, "/tmp/pending.wav");
  await expect.poll(() => Boolean(releaseInspection)).toBe(true);
  await expect(page.locator("[data-utterance-id]")).toHaveCount(0);

  await page.getByRole("button", { name: "プリセット", exact: true }).click();
  const card = page.locator(".preset-card").first();
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "削除", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "WAVを登録中" })).toBeVisible();
  await expect(card).toHaveCount(1);

  releaseInspection!();
  await page.getByRole("button", { name: "エラーを閉じる" }).click();
  await page.getByRole("button", { name: "セリフ", exact: true }).click();
  const row = page.locator("[data-utterance-id]");
  await expect(row).toHaveCount(1);
  await expect(row.first().locator("small").first()).toHaveText("/tmp/pending.wav");
  await page.getByRole("button", { name: "プリセット", exact: true }).click();
  await card.getByRole("button", { name: "削除", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "使用中" }))
    .toContainText("pending.wav");

  await page.getByRole("button", { name: "エラーを閉じる" }).click();
  await page.getByRole("button", { name: "セリフ", exact: true }).click();
  await page.getByRole("button", { name: "削除: 1 pending.wav" }).click();
  await expect(row).toHaveCount(0);
  await page.getByRole("button", { name: "プリセット", exact: true }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await card.getByRole("button", { name: "削除", exact: true }).click();
  await expect(card).toHaveCount(0);
});

test("a late WAV response cannot register a preset removed from persisted storage", async ({ page }) => {
  let releaseInspection: (() => void) | undefined;
  await page.route("**/api/wav", async (route) => {
    await new Promise<void>((resolve) => { releaseInspection = resolve; });
    await route.fulfill({ json: {
      samples: 1000, sample_rate: 1000, duration_seconds: 1,
    } });
  });
  await openSpeech(page);
  await page.getByRole("button", { name: "プリセット", exact: true }).click();
  await page.getByRole("button", { name: "＋ 作成" }).click();
  await page.getByRole("button", { name: "← 一覧へ" }).click();
  await page.getByRole("button", { name: "セリフ", exact: true }).click();
  await addWav(page, "/tmp/stale.wav");
  await expect.poll(() => Boolean(releaseInspection)).toBe(true);
  // Model a newer persisted preset snapshot from another tab while the API is pending.
  await page.evaluate(() => {
    const key = "tachie-motion.preset-draft.v2";
    const saved = JSON.parse(localStorage.getItem(key)!) as {
      collection: { items: Array<{ id: string }>; defaultId: string };
    };
    const formerDefault = saved.collection.defaultId;
    saved.collection.items = saved.collection.items.filter((item) => item.id !== formerDefault);
    saved.collection.defaultId = saved.collection.items[0].id;
    localStorage.setItem(key, JSON.stringify(saved));
  });
  releaseInspection!();
  await expect(page.getByRole("alert").filter({ hasText: "登録開始時のプリセット" }))
    .toContainText("登録し直してください");
  await expect(page.locator("[data-utterance-id]")).toHaveCount(0);
});

test("a late WAV response rejects a same-ID preset with invalid PSD paths", async ({ page }) => {
  let releaseInspection: (() => void) | undefined;
  await page.route("**/api/wav", async (route) => {
    await new Promise<void>((resolve) => { releaseInspection = resolve; });
    await route.fulfill({ json: {
      samples: 1000, sample_rate: 1000, duration_seconds: 1,
    } });
  });
  await openSpeech(page);
  await addWav(page, "/tmp/invalid-same-id.wav");
  await expect.poll(() => Boolean(releaseInspection)).toBe(true);
  const otherTab = await page.context().newPage();
  await otherTab.goto("/");
  await otherTab.evaluate(() => {
    const key = "tachie-motion.preset-draft.v2";
    const saved = JSON.parse(localStorage.getItem(key)!) as {
      collection: { items: Array<{ id: string; base: Array<{ path: string; visible: boolean }> }>;
        defaultId: string };
    };
    const preset = saved.collection.items.find((item) => item.id === saved.collection.defaultId)!;
    preset.base[0].path = "404"; // Valid JSON shape, but absent from the inspected PSD.
    localStorage.setItem(key, JSON.stringify(saved));
  });
  await otherTab.close();
  releaseInspection!();
  await expect(page.getByRole("alert").filter({ hasText: "登録開始時のプリセット" }))
    .toContainText("登録し直してください");
  await expect(page.locator("[data-utterance-id]")).toHaveCount(0);
});

test("a late WAV response rejects a changed preset even if its ID and PSD paths remain valid", async ({ page }) => {
  let releaseInspection: (() => void) | undefined;
  await page.route("**/api/wav", async (route) => {
    await new Promise<void>((resolve) => { releaseInspection = resolve; });
    await route.fulfill({ json: {
      samples: 1000, sample_rate: 1000, duration_seconds: 1,
    } });
  });
  await openSpeech(page);
  await addWav(page, "/tmp/changed-same-id.wav");
  await expect.poll(() => Boolean(releaseInspection)).toBe(true);
  await page.evaluate(() => {
    const key = "tachie-motion.preset-draft.v2";
    const saved = JSON.parse(localStorage.getItem(key)!) as {
      collection: { items: Array<{ id: string; name: string }>; defaultId: string };
    };
    saved.collection.items.find((item) => item.id === saved.collection.defaultId)!.name = "別タブで改名";
    localStorage.setItem(key, JSON.stringify(saved));
  });
  releaseInspection!();
  await expect(page.getByRole("alert").filter({ hasText: "登録開始時のプリセット" }))
    .toContainText("登録し直してください");
  await expect(page.locator("[data-utterance-id]")).toHaveCount(0);
});

test("batch MOV requests carry only their own preset changes", async ({ page }) => {
  await page.route("**/api/wav", (route) => route.fulfill({ json: {
    samples: 1000, sample_rate: 1000, duration_seconds: 1,
    source_identity: "1:2:3:4:5",
  } }));
  await openSpeech(page);
  const requests: Array<Record<string, unknown>> = [];
  await page.route("**/api/preset-batch-mov-export", (route) => {
    requests.push(route.request().postDataJSON() as Record<string, unknown>);
    return route.fulfill({ json: {
      mov: "/tmp/output/timeline.mov", frames: 30, sample_count: 1000, sample_rate: 1000,
    } });
  });
  await addWav(page, "/tmp/a.wav");
  await addWav(page, "/tmp/b.wav");
  const rows = page.locator("[data-utterance-id]");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(1)).toHaveAttribute("data-selected", "true");
  const editor = page.locator(".preset-change-editor");
  await editor.getByRole("slider", { name: /再生位置/ }).press("ArrowRight");
  await editor.getByRole("button", { name: /編集点を追加/ }).click();
  const time = editor.getByRole("spinbutton", { name: "編集点の時刻（秒）" });
  await time.fill("0.5");
  await time.press("Enter");
  await expect(editor.locator('[data-edit-point="500"]')).toHaveCount(1);
  await page.getByRole("radio", { name: /^全件/ }).check();
  await page.getByRole("button", { name: "全件を書き出す" }).click();
  await expect.poll(() => requests.length).toBe(2);
  expect(requests.map((value) => value.wav)).toEqual(["/tmp/a.wav", "/tmp/b.wav"]);
  expect(requests[0]).not.toHaveProperty("timeline_changes");
  expect(requests[1].timeline_changes).toMatchObject([{ sample: 500, mode: "none" }]);
});

test("selected WAV has one waveform and editable point rows with thumbnails", async ({ page }) => {
  await page.route("**/api/wav", (route) => route.fulfill({ json: {
    samples: 16000, sample_rate: 8000, duration_seconds: 2,
    source_identity: "1:2:3:4:5",
  } }));
  const waveformRequests: string[] = [];
  await page.route("**/api/wav-playback", (route) => {
    waveformRequests.push((route.request().postDataJSON() as { path: string }).path);
    return route.fulfill({ body: waveformTestWav(16000), contentType: "audio/wav" });
  });
  await openSpeech(page);
  await addWav(page, "/tmp/first.wav");
  await addWav(page, "/tmp/second.wav");
  const rows = page.locator("[data-utterance-id]");
  await expect(rows).toHaveCount(2);
  const second = rows.nth(1);
  await expect(second).toHaveAttribute("data-selected", "true");
  await expect(rows.nth(0).locator(".preset-change-editor")).toHaveCount(0);
  await expect(second.locator(".preset-change-editor")).toBeVisible();
  await expect(second.locator(".wav-waveform path")).toHaveAttribute("d", /^M/);
  expect(waveformRequests).toContain("/tmp/second.wav");
  await expect(second.locator(".preset-change-editor input[type=range]")).toHaveCount(0);
  await expect(page.locator(".utterance-playback audio")).not.toHaveAttribute("src", /^blob:/);

  await second.getByRole("button", { name: /プリセット編集を閉じる/ }).click();
  await expect(second.locator(".preset-change-editor")).toHaveCount(0);
  await second.getByRole("button", { name: /プリセット編集を開く/ }).click();
  const editor = second.locator(".preset-change-editor");
  const waveform = editor.locator(".wav-waveform");
  await expect(waveform).toBeVisible();
  const bounds = await waveform.boundingBox();
  expect(bounds).not.toBeNull();
  await waveform.click({ position: { x: bounds!.width * 0.25, y: bounds!.height / 2 } });
  await editor.getByRole("button", { name: /編集点を追加/ }).click();
  const marker = editor.locator(".preset-change-marker");
  await expect(marker).toHaveCount(1);
  const sample = Number(await marker.getAttribute("data-change-marker"));
  expect(Math.abs(sample - 4000)).toBeLessThanOrEqual(10);
  const row = editor.locator(".preset-change-points li");
  await expect(row).toHaveCount(1);
  const chooser = row.getByRole("button", { name: /秒のプリセット/ });
  await expect(chooser.locator(".preset-picker-thumb")).toHaveCount(1);
  await chooser.click();
  await expect(row.locator(".preset-picker-option .preset-picker-thumb")).toHaveCount(1);
  await row.locator(".preset-picker-option").first().click();

  const percentage = row.getByRole("spinbutton", { name: "編集点の位置（%）" });
  await percentage.fill("50");
  await percentage.press("Enter");
  await expect(editor.locator('[data-edit-point="8000"]')).toHaveCount(1);
  await expect(editor.locator('[data-change-marker="8000"]')).toHaveCount(1);
  await expect(editor.getByRole("spinbutton", { name: "編集点の時刻（秒）" }))
    .toHaveValue("1");
  await editor.getByRole("spinbutton", { name: "編集点の位置（%）" }).fill("100");
  await editor.getByRole("spinbutton", { name: "編集点の位置（%）" }).press("Tab");
  await expect(editor.locator('[data-edit-point="8000"]')).toHaveCount(1);

  await rows.nth(0).locator(".utterance-item-select").click();
  await expect(rows.nth(0).locator(".preset-change-editor")).toBeVisible();
  await expect(rows.nth(0).locator(".preset-change-points li")).toHaveCount(0);
  await expect(second.locator(".preset-change-editor")).toHaveCount(0);
});

test("Space plays and pauses the selected WAV without stealing form or button keys", async ({ page }) => {
  await page.route("**/api/wav", (route) => route.fulfill({ json: {
    samples: 16000, sample_rate: 8000, duration_seconds: 2,
    source_identity: "1:2:3:4:5",
  } }));
  await page.route("**/api/wav-playback", (route) =>
    route.fulfill({ body: waveformTestWav(16000), contentType: "audio/wav" }));
  await openSpeech(page);
  await addWav(page, "/tmp/space.wav");
  const row = page.locator("[data-utterance-id]").first();
  await row.locator(".utterance-item-select").click();
  await page.keyboard.press("Space");
  await expect(row.locator(".utterance-item-play")).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Space");
  await expect(row.locator(".utterance-item-play")).toHaveAttribute("aria-pressed", "false");

  const waveform = row.locator(".preset-change-editor .wav-waveform");
  await expect(waveform).toBeVisible();
  const bounds = await waveform.boundingBox();
  expect(bounds).not.toBeNull();
  await waveform.click({ position: { x: bounds!.width / 4, y: bounds!.height / 2 } });
  await page.keyboard.press("Space");
  await expect(row.locator(".utterance-item-play")).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => page.locator(".utterance-playback audio").evaluate(
    (el) => (el as HTMLAudioElement).currentTime)).toBeGreaterThan(0.3);
  await row.getByRole("button", { name: /編集点を追加/ }).click();
  const field = row.getByRole("spinbutton", { name: "編集点の時刻（秒）" });
  await field.focus();
  await page.keyboard.press("Space");
  await expect(row.locator(".utterance-item-play")).toHaveAttribute("aria-pressed", "true");
});
