import { expect, test } from "@playwright/test";
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
