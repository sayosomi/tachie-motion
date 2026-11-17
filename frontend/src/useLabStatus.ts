import { useEffect, useState } from "react";
import type { UtteranceItem } from "./utteranceItems";

export type LabInfo = {
  status: "valid" | "missing" | "invalid" | "checking" | "unavailable";
  reason: string | null;
};
type LabResponse = { status: "valid" | "missing" | "invalid"; reason: string | null };
type CheckedStatus = { key: string; value: LabInfo };

function identityKey(item: UtteranceItem): string {
  return JSON.stringify([item.id, item.wavPath, item.wav.source_identity]);
}

function isLabResponse(value: unknown): value is LabResponse {
  if (!value || typeof value !== "object") return false;
  const result = value as Record<string, unknown>;
  return (result.status === "valid" || result.status === "missing" || result.status === "invalid") &&
    (result.reason === null || typeof result.reason === "string");
}

/** Async WAV-side LAB inspections are derived state, never project JSON data. */
export function useLabStatus(items: UtteranceItem[], active: boolean): Record<string, LabInfo> {
  const [checked, setChecked] = useState<Record<string, CheckedStatus>>({});
  const key = JSON.stringify(items.map((item) => identityKey(item)));
  useEffect(() => {
    let cancelled = false;
    if (!active) {
      setChecked({});
      return () => { cancelled = true; };
    }
    const expected = new Set(items.map((item) => identityKey(item)));
    setChecked((previous) => Object.fromEntries(
      Object.entries(previous).filter(([, value]) => expected.has(value.key))));
    const candidates = items.filter((item) =>
      typeof item.wav.source_identity === "string" && item.wav.source_identity.length > 0 &&
      checked[item.id]?.key !== identityKey(item));
    let next = 0;
    const worker = async () => {
      while (!cancelled) {
        const item = candidates[next++];
        if (!item) return;
        let value: LabInfo;
        try {
          const response = await fetch("/api/wav-lab", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              path: item.wavPath, source_identity: item.wav.source_identity,
            }),
          });
          const result: unknown = await response.json();
          if (!response.ok || !isLabResponse(result)) {
            throw new Error("LABの確認結果を取得できません");
          }
          value = result;
        } catch (error) {
          value = {
            status: "unavailable",
            reason: error instanceof Error ? error.message : String(error),
          };
        }
        if (!cancelled) {
          setChecked((previous) => ({
            ...previous, [item.id]: { key: identityKey(item), value },
          }));
        }
      }
    };
    // Limit simultaneous filesystem inspection requests even with large projects.
    void Promise.all(Array.from({ length: Math.min(4, candidates.length) }, worker));
    return () => { cancelled = true; };
  }, [key, active]);

  return Object.fromEntries(items.map((item) => {
    if (!item.wav.source_identity) {
      return [item.id, { status: "unavailable", reason: null }];
    }
    return [item.id, checked[item.id]?.key === identityKey(item)
      ? checked[item.id].value : { status: "checking", reason: null }];
  }));
}
