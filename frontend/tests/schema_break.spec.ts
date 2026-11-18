import { expect, test } from "@playwright/test";
import { CHARACTER_PROFILE_FORMAT, CHARACTER_PROFILE_VERSION,
  parseCharacterProfile } from "../src/characterProfile";
import { PROJECT_FORMAT, PROJECT_VERSION, parseProjectFile } from "../src/projectFile";
import { aiueoMouthReady, exportReady } from "../src/utteranceExportRequest";
import type { UnifiedPreset } from "../src/presetModel";
import type { UtteranceItem } from "../src/utteranceItems";

test("obsolete character/project JSON formats are rejected instead of migrated", () => {
  const profile = {
    format: CHARACTER_PROFILE_FORMAT,
    version: CHARACTER_PROFILE_VERSION - 1,
    source: { path: "/tmp/old.psd", fingerprint: "1:2", layerPaths: ["0"] },
    collection: { items: [], defaultId: null },
  };
  expect(() => parseCharacterProfile(JSON.stringify(profile))).toThrow("未対応");
  const project = {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION - 1,
    character: { ...profile, version: CHARACTER_PROFILE_VERSION },
    items: [], selectedId: null, naming: {},
  };
  expect(() => parseProjectFile(JSON.stringify(project))).toThrow("未対応");
});

test("fixed-matching Open selection is valid; aiueo requires all six explicit selections", () => {
  const preset: UnifiedPreset = {
    id: "p", name: "通常", blinkEnabled: false, mouthMotionEnabled: true,
    base: [{ path: "0/0", visible: true }],
    openMouth: {
      closed: [{ path: "0/0", visible: true }],
      opened: [{ path: "0/0", visible: true }],
    },
    aiueoMouth: {
      a: [{ path: "0/0", visible: true }],
      i: [{ path: "0/0", visible: true }],
      u: [{ path: "0/0", visible: true }],
      e: [{ path: "0/0", visible: true }],
      o: [{ path: "0/0", visible: true }],
      n: [],
    },
  };
  expect(exportReady(preset, { mode: "open" } as UtteranceItem)).toBe(true);
  expect(aiueoMouthReady(preset)).toBe(false);
  preset.aiueoMouth!.n = [{ path: "0/0", visible: true }];
  expect(aiueoMouthReady(preset)).toBe(true);
});

test("obsolete browser draft is ignored without rewriting its bytes", async ({ page }) => {
  await page.goto("/");
  const old = '{"version":1,"path":"/tmp/old.psd","collection":{"items":[]}}';
  await page.evaluate((text) => localStorage.setItem(
    "tachie-motion.preset-draft.v1", text), old);
  await page.reload();
  expect(await page.evaluate(() =>
    localStorage.getItem("tachie-motion.preset-draft.v1"))).toBe(old);
  await expect(page.getByText("前回の編集を復元しました。")).toHaveCount(0);
});
