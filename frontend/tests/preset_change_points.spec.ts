import { expect, test } from "@playwright/test";
import { createUtterance } from "../src/utteranceItems";
import { exportPayload, exportReadinessError } from "../src/utteranceExportRequest";
import type { PresetDraft } from "../src/presetDraftStorage";
import {
  addPresetChangePoint, assertPresetChangePoints, frameCenterSample,
  movePresetChangePoint, presetAtSample, removePresetChangePoint,
  replacePresetChangePoint, MAX_PRESET_CHANGE_POINTS,
} from "../src/presetChangePoints";

const ids = new Set(["normal", "smile", "surprised"]);
const samples = 48_000;

test("sample 0 uses initial preset and change points hold through the next point", () => {
  const points = [{ sample: 12_000, presetId: "smile" },
    { sample: 36_000, presetId: "surprised" }];
  assertPresetChangePoints(points, samples, ids);
  expect(presetAtSample("normal", points, 0)).toBe("normal");
  expect(presetAtSample("normal", points, 11_999)).toBe("normal");
  expect(presetAtSample("normal", points, 12_000)).toBe("smile");
  expect(presetAtSample("normal", points, 35_999)).toBe("smile");
  expect(presetAtSample("normal", points, 36_000)).toBe("surprised");
  expect(presetAtSample("normal", points, 47_999)).toBe("surprised");
});

test("immutable add, move, replace and remove never change earlier WAV edits", () => {
  const first = addPresetChangePoint([], 12_000, "smile", samples, ids);
  const second = addPresetChangePoint(first, 6_000, "surprised", samples, ids);
  const moved = movePresetChangePoint(second, 6_000, 20_000, samples, ids);
  const replaced = replacePresetChangePoint(moved, 12_000, "normal", samples, ids);
  const removed = removePresetChangePoint(replaced, 20_000, samples, ids);
  expect(first).toEqual([{ sample: 12_000, presetId: "smile" }]);
  expect(second.map((point) => point.sample)).toEqual([6_000, 12_000]);
  expect(moved.map((point) => point.sample)).toEqual([12_000, 20_000]);
  expect(replaced[0].presetId).toBe("normal");
  expect(removed).toEqual([{ sample: 12_000, presetId: "normal" }]);
  expect(second[0].presetId).toBe("surprised");
});

test("reject invalid times, duplicates, reverse order and missing preset references", () => {
  const base = [{ sample: 12_000, presetId: "smile" }];
  const invalid: unknown[] = [
    [{ sample: 0, presetId: "smile" }],
    [{ sample: samples, presetId: "smile" }],
    [{ sample: -1, presetId: "smile" }],
    [{ sample: 1.5, presetId: "smile" }],
    [{ sample: Number.NaN, presetId: "smile" }],
    [{ sample: 4, presetId: "missing" }],
    [{ sample: 4, presetId: "smile", extra: "bad" }],
    [{ sample: 12_000, presetId: "smile" }, { sample: 12_000, presetId: "normal" }],
    [{ sample: 12_000, presetId: "smile" }, { sample: 8_000, presetId: "normal" }],
    [{}], null, {},
  ];
  for (const value of invalid) {
    expect(() => assertPresetChangePoints(value, samples, ids)).toThrow();
  }
  expect(() => addPresetChangePoint(base, 12_000, "normal", samples, ids)).toThrow();
  expect(() => movePresetChangePoint(base, 12_000, 0, samples, ids)).toThrow();
  expect(() => movePresetChangePoint(base, 1, 20_000, samples, ids)).toThrow();
  expect(() => replacePresetChangePoint(base, 12_000, "deleted", samples, ids)).toThrow();
  expect(() => removePresetChangePoint(base, 10, samples, ids)).toThrow();
});

test("change point limit and single-sample WAV reject unrepresentable boundaries", () => {
  const points = Array.from({ length: MAX_PRESET_CHANGE_POINTS }, (_, i) =>
    ({ sample: i + 1, presetId: "normal" }));
  assertPresetChangePoints(points, samples, ids);
  expect(() => addPresetChangePoint(points, 20_000, "smile", samples, ids)).toThrow();
  expect(() => addPresetChangePoint([], 1, "smile", 1, ids)).toThrow();
  expect(() => assertPresetChangePoints(points, 1, ids)).toThrow();
});

test("frame-center sample uses PCM time at 24/30/60fps and clamps the final frame", () => {
  expect(frameCenterSample(0, 24, 48_000, 48_000)).toBe(1000);
  expect(frameCenterSample(0, 30, 48_000, 48_000)).toBe(800);
  expect(frameCenterSample(1, 30, 48_000, 48_000)).toBe(2400);
  expect(frameCenterSample(0, 60, 48_000, 48_000)).toBe(400);
  expect(frameCenterSample(30, 30, 48_000, 48_001)).toBe(48_000);
  expect(frameCenterSample(1, 24, 48_000, 1)).toBe(0);
  expect(presetAtSample("normal", [{ sample: 1600, presetId: "smile" }],
    frameCenterSample(1, 30, 48_000, 48_000))).toBe("smile");
});

test("integer arithmetic stays exact above floating-point multiplication limits", () => {
  const sampleRate = 192_000;
  const length = Number.MAX_SAFE_INTEGER;
  const frame = 1_000_000_000_000;
  const expected = Number(((BigInt(2) * BigInt(frame) + BigInt(1)) *
    BigInt(sampleRate)) / BigInt(60));
  expect(frameCenterSample(frame, 30, sampleRate, length)).toBe(expected);
});

test("eye group bindings cover both OFF-to-ON and ON-to-OFF preset timelines", () => {
  const draft: PresetDraft = {
    version: 2, path: "/tmp/character.psd", fingerprint: "synthetic",
    nameDrafts: {},
    collection: {
      defaultId: "off",
      motionGroups: { mouth: [], eyes: ["0"] },
      blinkTiming: {
        intervalMs: 1000, closedMs: 100, jitterMs: 0, phaseMs: 0, seed: 1,
      },
      items: [
        { id: "off", name: "瞬きOFF", blinkEnabled: false,
          base: [{ path: "0", visible: true }] },
        { id: "on", name: "瞬きON", blinkEnabled: true,
          base: [{ path: "0", visible: true }],
          eyes: { opened: [], closed: [{ path: "0/1", visible: true }] } },
      ],
    },
  };
  const [off, on] = draft.collection.items;
  const wav = {
    samples: 1000, sample_rate: 1000, duration_seconds: 1,
    source_identity: "1:2:3:4:5",
  };

  const firstOff = createUtterance("wav-off", "/tmp/wav-off.wav", wav, "off", "/tmp", 1);
  firstOff.presetChanges = [{ sample: 500, presetId: "on" }];
  expect(exportReadinessError(off, firstOff, undefined, draft.collection)).toBeNull();
  const offToOn = exportPayload(draft, firstOff, off, "off-to-on", "error");
  expect(offToOn.eye_groups).toEqual(["0"]);
  expect(offToOn.blink_enabled).toBe(false);
  expect(offToOn.timeline_changes).toMatchObject([
    { sample: 500, preset_id: "on", blink_enabled: true },
  ]);

  const firstOn = createUtterance("wav-on", "/tmp/wav-on.wav", wav, "on", "/tmp", 2);
  firstOn.presetChanges = [{ sample: 500, presetId: "off" }];
  expect(exportReadinessError(on, firstOn, undefined, draft.collection)).toBeNull();
  const onToOff = exportPayload(draft, firstOn, on, "on-to-off", "error");
  expect(onToOff.eye_groups).toEqual(["0"]);
  expect(onToOff.blink_enabled).toBe(true);
  expect(onToOff.timeline_changes).toMatchObject([
    { sample: 500, preset_id: "off", blink_enabled: false },
  ]);

  const alwaysOff = createUtterance("wav-static", "/tmp/wav-static.wav", wav, "off", "/tmp", 3);
  const noBlink = exportPayload(draft, alwaysOff, off, "static", "error");
  expect(noBlink.eye_groups).toBeNull();
  expect(noBlink).not.toHaveProperty("timeline_changes");
});
