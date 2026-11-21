import { expect, test, type Page } from "@playwright/test";

const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+tmdoAAAAASUVORK5CYII=";
const layers = [
  { path: "0", name: "eyes", kind: "group", visible: true, effective_visible: true, bbox: [0, 0, 64, 64] },
  { path: "0/0", name: "open", kind: "pixel", visible: true, effective_visible: true, bbox: [0, 0, 24, 24] },
  { path: "0/1", name: "closed", kind: "pixel", visible: false, effective_visible: false, bbox: [0, 0, 24, 24] },
];
const base = layers.map((layer) => ({ path: layer.path, visible: layer.visible }));
const identity = "1:2:3:4:5";
const draft = {
  version: 2, path: "/tmp/立ち絵.psd", fingerprint: "1000:2000",
  collection: {
    defaultId: "p1",
    items: [{ id: "p1", name: "通常", base, blinkEnabled: false },
      { id: "p2", name: "瞬き", base, blinkEnabled: true }],
    blinkTiming: { intervalMs: 3000, closedMs: 120, jitterMs: 500, phaseMs: 700, seed: 0 },
    motionGroups: { mouth: [], eyes: ["0"] },
  },
  nameDrafts: {},
};

async function setup(page: Page, presetDraft: object = draft,
  waitReady = true, openIdle = true) {
  await page.addInitScript((record) => {
    localStorage.setItem("tachie-motion.preset-draft.v2", JSON.stringify(record));
  }, presetDraft);
  await page.route("**/api/psd", (route) => route.fulfill({ json: {
    width: 64, height: 64, preview: png,
    fingerprint: "1000:2000", source_identity: identity, layers,
  } }));
  await page.route("**/api/health", (route) => route.fulfill({ json: {
    ok: true, default_output_dir: "/tmp/render-out",
  } }));
  await page.route("**/api/preset-utterance-destination", (route) => route.fulfill({ json: {
    state: "available", suggested_basename: "待機_002",
  } }));
  await page.route("**/api/export-progress-reserve", (route) => route.fulfill({ json: {
    registered: true,
  } }));
  await page.goto("/");
  if (openIdle) await page.getByRole("button", { name: "待機MOV", exact: true }).click();
  await expect(page.getByRole("heading", { name: "場面専用の待機MOV" })).toBeVisible();
  if (waitReady) await expect(page.locator("#idle-preset")).toBeEnabled();
}

test("direct silent MOV export forwards exact frames, preset and Unicode name", async ({ page }) => {
  await setup(page);
  await page.locator("#idle-frames").fill("48");
  await page.locator("#idle-fps").selectOption("24");
  await page.locator("#idle-basename").fill("シーン_あんこもんだんもん");
  await expect(page.getByText("再生尺 2 秒（48 フレーム）")).toBeVisible();
  const payloads: Record<string, unknown>[] = [];
  await page.route("**/api/idle-motion-export", (route) => {
    payloads.push(route.request().postDataJSON());
    return route.fulfill({ json: { mov: "/tmp/render-out/シーン.mov", frames: 48 } });
  });
  const start = page.getByRole("button", { name: "待機MOVを書き出す" });
  await expect(start).toBeEnabled();
  await start.click();
  await expect(page.getByRole("dialog")).toContainText("書き出し完了");
  expect(payloads).toHaveLength(1);
  expect(payloads[0]).toMatchObject({
    psd: "/tmp/立ち絵.psd", fingerprint: "1000:2000", source_identity: identity,
    frame_count: 48, fps: 24, basename: "シーン_あんこもんだんもん",
    output_dir: "/tmp/render-out", conflict_policy: "error", blink_enabled: false,
  });
  expect(payloads[0]).not.toHaveProperty("wav");
  expect(payloads[0]).not.toHaveProperty("otio");
  await page.getByRole("button", { name: "編集画面に戻る" }).click();
  await expect(page.getByText("48フレームのMOVを書き出しました")).toBeVisible();
});

test("invalid frame count and stale PSD refuse reservation and export", async ({ page }) => {
  await setup(page);
  let reservations = 0;
  let exports = 0;
  await page.route("**/api/export-progress-reserve", (route) => {
    reservations++;
    return route.fulfill({ json: { registered: true } });
  });
  await page.route("**/api/idle-motion-export", (route) => {
    exports++;
    return route.fulfill({ json: { mov: "should-not-write", frames: 1 } });
  });
  await page.locator("#idle-frames").fill("2.5");
  await expect(page.getByRole("button", { name: "待機MOVを書き出す" })).toBeDisabled();
  await page.locator("#idle-frames").fill("150");
  await page.route("**/api/psd", (route) => {
    return route.fulfill({ json: {
      width: 64, height: 64, preview: png, layers,
      fingerprint: "1000:changed",
      source_identity: "changed",
    } });
  });
  await page.getByRole("button", { name: "待機MOVを書き出す" }).click();
  await expect(page.getByRole("alert")).toContainText("変更されています");
  expect(reservations).toBe(0);
  expect(exports).toBe(0);
});

test("same-name MOV defaults to save-as and requires explicit overwrite", async ({ page }) => {
  await setup(page);
  const requests: { basename: string; conflict_policy: string }[] = [];
  await page.route("**/api/preset-utterance-destination", (route) => {
    const { basename } = route.request().postDataJSON() as { basename: string };
    return route.fulfill({ json: {
      state: basename === "待機" ? "complete" : "available",
      suggested_basename: "待機_002",
    } });
  });
  await page.route("**/api/idle-motion-export", (route) => {
    requests.push(route.request().postDataJSON());
    return route.fulfill({ json: { mov: "saved", frames: 150 } });
  });
  // Refresh the destination after replacing the fixture's default route.
  await page.locator("#idle-basename").fill("temp");
  await page.locator("#idle-basename").fill("待機");
  await expect(page.getByLabel("待機MOVの出力予定")).toContainText("待機_002.mov");
  await page.getByRole("button", { name: "待機MOVを書き出す" }).click();
  await expect(page.getByRole("dialog")).toContainText("書き出し完了");
  expect(requests[0]).toMatchObject({ basename: "待機_002", conflict_policy: "error" });
  await page.getByRole("button", { name: "編集画面に戻る" }).click();
  await page.getByRole("radio", { name: "明示的に上書き" }).check();
  await expect(page.getByLabel("待機MOVの出力予定")).toContainText("待機.mov");
  await page.getByRole("button", { name: "待機MOVを書き出す" }).click();
  await expect(page.getByRole("dialog")).toContainText("書き出し完了");
  expect(requests[1]).toMatchObject({ basename: "待機", conflict_policy: "overwrite" });
});

test("overwrite approval never follows a new basename or output folder", async ({ page }) => {
  await setup(page);
  const sent: { basename: string; conflict_policy: string; output_dir: string }[] = [];
  await page.route("**/api/preset-utterance-destination", (route) => {
    const { basename } = route.request().postDataJSON() as { basename: string };
    return route.fulfill({ json: {
      state: basename === "既存A" || basename === "既存B" ? "complete" : "available",
      suggested_basename: basename + "_002",
    } });
  });
  await page.route("**/api/idle-motion-export", (route) => {
    sent.push(route.request().postDataJSON());
    return route.fulfill({ json: { mov: "saved", frames: 150 } });
  });
  const name = page.locator("#idle-basename");
  const saveAs = page.getByRole("radio", { name: "別名で保存" });
  const overwrite = page.getByRole("radio", { name: "明示的に上書き" });
  await name.fill("既存A");
  await expect(overwrite).toBeVisible();
  await overwrite.check();
  await expect(page.getByLabel("待機MOVの出力予定")).toContainText("既存A.mov");

  await name.fill("既存B");
  await expect(saveAs).toBeChecked();
  await expect(page.getByLabel("待機MOVの出力予定")).toContainText("既存B_002.mov");
  await page.getByRole("button", { name: "待機MOVを書き出す" }).click();
  await expect(page.getByRole("dialog")).toContainText("書き出し完了");
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ basename: "既存B_002", conflict_policy: "error" });
  await page.getByRole("button", { name: "編集画面に戻る" }).click();

  await overwrite.check();
  await expect(page.getByLabel("待機MOVの出力予定")).toContainText("既存B.mov");
  await page.locator("#idle-output-dir-advanced summary").click();
  await page.locator("#idle-output-dir").fill("/tmp/other-output");
  await expect(saveAs).toBeChecked();
  await expect(page.getByLabel("待機MOVの出力予定")).toContainText("既存B_002.mov");
  await page.locator("#idle-output-dir").fill("/tmp/render-out");
  await expect(saveAs).toBeChecked();
  await name.fill("既存A");
  await expect(saveAs).toBeChecked();
  await expect(page.getByLabel("待機MOVの出力予定")).toContainText("既存A_002.mov");
});

test("blink ON cannot export with incomplete eye setup", async ({ page }) => {
  await setup(page);
  await page.locator("#idle-preset").selectOption("p2");
  await expect(page.getByText(/閉じ目レイヤーをプリセットで明示選択/)).toBeVisible();
  await expect(page.getByRole("button", { name: "待機MOVを書き出す" })).toBeDisabled();
});

test("valid blink ON forwards only the stored eye groups, closed shape and frame timing", async ({ page }) => {
  const eyes = {
    opened: [{ path: "0/0", visible: true }, { path: "0/1", visible: false }],
    closed: [{ path: "0/0", visible: false }, { path: "0/1", visible: true }],
  };
  const snapshot = { ...draft, collection: {
    ...draft.collection,
    items: [draft.collection.items[0], { ...draft.collection.items[1], eyes }],
  } };
  await setup(page, snapshot);
  await page.locator("#idle-preset").selectOption("p2");
  const sent: Record<string, unknown>[] = [];
  await page.route("**/api/idle-motion-export", (route) => {
    sent.push(route.request().postDataJSON());
    return route.fulfill({ json: { mov: "blink.mov", frames: 150 } });
  });
  await page.getByRole("button", { name: "待機MOVを書き出す" }).click();
  await expect(page.getByRole("dialog")).toContainText("書き出し完了");
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({
    blink_enabled: true, eyes, eye_groups: ["0"],
    blink_timing: {
      interval_frames: 90, closed_frames: 4, jitter_frames: 15,
      phase_frames: 21, seed: 0,
    },
  });
});

test("progress modal holds tab navigation until the worker completes", async ({ page }) => {
  await setup(page);
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  let requests = 0;
  await page.route("**/api/idle-motion-export", async (route) => {
    requests++;
    await hold;
    await route.fulfill({ json: { mov: "done", frames: 150 } });
  });
  await page.getByRole("button", { name: "待機MOVを書き出す" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("button", { name: "セリフ", exact: true })).toBeDisabled();
  release();
  await expect(page.getByRole("dialog")).toContainText("書き出し完了");
  await expect(page.getByRole("button", { name: "セリフ", exact: true })).toBeEnabled();
  expect(requests).toBe(1);
});

test("unsafe existing MOV can only use a distinct free basename; recovery blocks both", async ({ page }) => {
  await setup(page);
  let blocking = false;
  await page.route("**/api/preset-utterance-destination", (route) => {
    const { basename } = route.request().postDataJSON() as { basename: string };
    return route.fulfill({ json: {
      state: basename === "待機" ? "unsafe" : "available",
      suggested_basename: "待機_002",
      folder_recovery_required: blocking,
    } });
  });
  await page.locator("#idle-basename").fill("temp");
  await page.locator("#idle-basename").fill("待機");
  await expect(page.locator("#idle-alternate-name")).toHaveValue("待機_002");
  await expect(page.getByRole("radio", { name: "明示的に上書き" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "待機MOVを書き出す" })).toBeEnabled();
  blocking = true;
  await page.locator("#idle-basename").fill("temp");
  await page.locator("#idle-basename").fill("待機");
  await expect(page.getByRole("button", { name: "待機MOVを書き出す" })).toBeDisabled();
});

test("server-confirmed cancellation shows cancelled, never success", async ({ page }) => {
  await setup(page);
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  let cancelled = false;
  await page.route("**/api/export-progress/*", (route) => route.fulfill({ json: {
    status: cancelled ? "cancelling" : "running",
    stage: "映像フレームを送信中", percent: 25, index: 1, total: 1,
    frames: 20, frame_total: 150, can_cancel: !cancelled,
  } }));
  await page.route("**/api/export-cancel", (route) => {
    cancelled = true;
    return route.fulfill({ json: { accepted: true, status: "cancelling" } });
  });
  await page.route("**/api/idle-motion-export", async (route) => {
    await hold;
    await route.fulfill({ status: 409, json: { detail: "書き出しをキャンセルしました" } });
  });
  await page.getByRole("button", { name: "待機MOVを書き出す" }).click();
  await expect(page.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "25");
  await page.getByRole("button", { name: "書き出しをキャンセル" }).click();
  await expect(page.getByRole("dialog")).toContainText("キャンセル処理中");
  release();
  await expect(page.getByRole("dialog")).toContainText("書き出しをキャンセルしました");
  await expect(page.getByRole("dialog")).not.toContainText("書き出し完了");
});

test("lost POST response keeps the operation locked until a terminal progress snapshot", async ({ page }) => {
  await setup(page);
  let terminal = false;
  await page.route("**/api/export-progress/*", (route) => route.fulfill({ json: {
    status: terminal ? "success" : "running", stage: "ProRes処理中",
    percent: terminal ? 100 : 91, index: 1, total: 1,
    frames: 150, frame_total: 150, can_cancel: !terminal,
  } }));
  await page.route("**/api/idle-motion-export", (route) => route.abort("failed"));
  await page.getByRole("button", { name: "待機MOVを書き出す" }).click();
  await expect(page.getByRole("dialog")).toContainText("通信が切れました");
  await expect(page.getByRole("button", { name: "セリフ", exact: true })).toBeDisabled();
  expect(await page.getByRole("dialog").getByRole("button", { name: "編集画面に戻る" }).count()).toBe(0);
  terminal = true;
  await expect(page.getByRole("dialog")).toContainText("書き出し完了");
  await expect(page.getByRole("button", { name: "セリフ", exact: true })).toBeEnabled();
});

test("reload recovery of an active export blocks new work then reloads the PSD", async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem(
    "tachie-motion-active-export-progress", JSON.stringify({
      token: "restored-idle-token-123456789", names: ["待機.mov"], kind: "idle",
    })));
  let done = false;
  await page.route("**/api/export-progress/*", (route) => route.fulfill({ json: {
    status: done ? "success" : "running", stage: "MOV処理中",
    percent: done ? 100 : 60, index: 1, total: 1,
    frames: done ? 150 : 90, frame_total: 150, can_cancel: !done,
  } }));
  // Do not click the idle tab: recovery must lock from the first app render.
  await setup(page, draft, false, false);
  await expect(page.getByRole("dialog")).toContainText("書き出し中");
  await expect(page.getByRole("button", { name: "プリセット", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "セリフ", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "待機MOVを書き出す" })).toBeDisabled();
  done = true;
  await expect(page.getByRole("dialog")).toContainText("書き出し完了");
  await page.getByRole("button", { name: "編集画面に戻る" }).click();
  await expect(page.locator("#idle-preset")).toBeEnabled();
  await expect(page.getByRole("button", { name: "待機MOVを書き出す" })).toBeEnabled();
});

test("refreshing active idle export restores the modal without opening its tab", async ({ page }) => {
  await setup(page);
  let done = false;
  await page.route("**/api/export-progress/*", (route) => route.fulfill({ json: {
    status: done ? "success" : "running", stage: "ProRes処理中",
    percent: done ? 100 : 60, index: 1, total: 1,
    frames: done ? 150 : 90, frame_total: 150, can_cancel: !done,
  } }));
  await page.route("**/api/idle-motion-export", (route) => route.abort("failed"));
  await page.getByRole("button", { name: "待機MOVを書き出す" }).click();
  await expect(page.getByRole("dialog")).toContainText("通信が切れました");
  await page.reload();
  await expect(page.getByRole("heading", { name: "場面専用の待機MOV" })).toBeVisible();
  await expect(page.getByRole("dialog")).toContainText("書き出し中");
  await expect(page.getByRole("button", { name: "プリセット", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "セリフ", exact: true })).toBeDisabled();
  done = true;
  await expect(page.getByRole("dialog")).toContainText("書き出し完了");
  await page.getByRole("button", { name: "編集画面に戻る" }).click();
  await expect(page.getByRole("button", { name: "プリセット", exact: true })).toBeEnabled();
});
