import { useState, type Dispatch, type SetStateAction } from "react";
import type { PresetDraft } from "./presetDraftStorage";
import type { UnifiedPreset } from "./presetModel";
import type { ExportData, UtteranceItem } from "./utteranceItems";

type Destination = {
  state: "available" | "complete" | "partial" | "unsafe" | "recovery_required";
  suggested_basename: string;
  canonical_output_dir?: string;
};
type Plan = {
  item: UtteranceItem;
  preset: UnifiedPreset;
  basename: string;
  conflict_policy: "overwrite" | "error";
};

async function post<T>(route: string, body: object): Promise<T> {
  const response = await fetch("/api/" + route, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await response.json() as T & { detail?: string };
  if (!response.ok) throw new Error(result.detail || "HTTP " + response.status);
  return result;
}

function ready(preset: UnifiedPreset, item: UtteranceItem): boolean {
  const mouth = preset.openMouth;
  return !preset.blinkEnabled && (item.mode === "none" ||
    Boolean(mouth?.closed.length && mouth.closed.length === mouth.opened.length &&
      JSON.stringify(mouth.closed) !== JSON.stringify(mouth.opened)));
}

async function prepare(items: UtteranceItem[], draft: PresetDraft): Promise<{
  plans: Plan[];
  overwrites: number;
}> {
  const plans: Plan[] = [];
  const destinations = new Set<string>();
  let overwrites = 0;

  for (const item of items) {
    const preset = draft.collection.items.find((entry) => entry.id === item.presetId);
    if (!preset || !ready(preset, item)) {
      throw new Error(item.wavPath + " — 口パク・プリセットの設定を確認してください");
    }
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(item.basename)) {
      throw new Error(item.wavPath + " — 出力ファイル名が不正です");
    }
    const destination = await post<Destination>("preset-utterance-destination", {
      output_dir: item.outputDir, basename: item.basename,
    });
    const alternate = destination.state !== "available" &&
      (destination.state !== "complete" || item.conflictChoice === "rename");
    const basename = alternate ?
      item.saveAsName ?? destination.suggested_basename : item.basename;
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(basename) ||
        (alternate && basename === item.basename)) {
      throw new Error(item.wavPath + " — 別名のファイル名を確認してください");
    }
    // Verify the alternate target rather than assuming a suggested name is free.
    if (alternate) {
      const alternateStatus = await post<Destination>("preset-utterance-destination", {
        output_dir: item.outputDir, basename,
      });
      if (alternateStatus.state !== "available") {
        throw new Error(item.wavPath + " — 別名の出力先にもファイルがあります");
      }
    }
    const folder = destination.canonical_output_dir ?? item.outputDir;
    const key = folder.normalize("NFC").toLocaleLowerCase() + "\0" +
      basename.normalize("NFC").toLocaleLowerCase();
    if (destinations.has(key)) {
      throw new Error("複数のセリフが同じ出力先に保存されます: " + basename);
    }
    destinations.add(key);
    const conflict_policy = !alternate && destination.state === "complete" ?
      "overwrite" : "error";
    if (conflict_policy === "overwrite") overwrites++;
    plans.push({ item, preset, basename, conflict_policy });
  }
  return { plans, overwrites };
}

export function useBatchUtteranceExport(
  draft: PresetDraft | null, items: UtteranceItem[],
  setItems: Dispatch<SetStateAction<UtteranceItem[]>>,
  onFinished: () => void,
) {
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState("");
  const [summary, setSummary] = useState("");

  async function run() {
    if (running || !draft || items.length === 0) return;
    setRunning(true);
    setSummary("");
    setProgress("出力先とプリセットを確認中…");
    try {
      const { plans, overwrites } = await prepare([...items], draft);
      if (overwrites > 0 && !window.confirm(
        `既存のMOVとOTIOを${overwrites}組上書きします。続行しますか？`
      )) {
        setProgress("");
        setSummary("一括書き出しをキャンセルしました。");
        return;
      }
      let successes = 0;
      let failures = 0;
      for (const [index, plan] of plans.entries()) {
        const item = plan.item;
        setProgress(`書き出し中 ${index + 1} / ${plans.length}：${item.wavPath}`);
        try {
          const result = await post<ExportData>("preset-utterance-export", {
            psd: draft.path, wav: item.wavPath, fingerprint: draft.fingerprint,
            layers: plan.preset.base, mouth: plan.preset.openMouth ?? null,
            mode: item.mode, blink_enabled: plan.preset.blinkEnabled,
            output_dir: item.outputDir, basename: plan.basename,
            conflict_policy: plan.conflict_policy, fps: item.fps,
          });
          successes++;
          setItems((previous) => previous.map((entry) => entry.id === item.id ?
            { ...entry, result, error: "" } : entry));
        } catch (error) {
          failures++;
          setItems((previous) => previous.map((entry) => entry.id === item.id ?
            { ...entry, result: null, error: error instanceof Error ? error.message : String(error) } :
            entry));
        }
      }
      setSummary(`一括書き出し完了：成功 ${successes} 件／失敗 ${failures} 件。各セリフの結果を確認してください。`);
      setProgress("");
      onFinished();
    } catch (error) {
      setProgress("");
      setSummary("一括書き出しを開始できません: " +
        (error instanceof Error ? error.message : String(error)));
    } finally {
      setRunning(false);
    }
  }

  return { running, progress, summary, run };
}
