import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { PresetDraft } from "./presetDraftStorage";
import type { UnifiedPreset } from "./presetModel";
import { exportPayload, exportReady } from "./utteranceExportRequest";
import type { ExportData, UtteranceItem } from "./utteranceItems";

type Destination = {
  state: "available" | "complete" | "partial" | "unsafe" | "recovery_required";
  suggested_basename: string;
  canonical_output_dir?: string;
};
export type Plan = {
  item: UtteranceItem;
  preset: UnifiedPreset;
  basename: string;
  conflict_policy: "overwrite" | "error";
  canonicalOutputDir: string;
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

export type PreparedBatch = {
  plans: Plan[];
  overwrites: number;
};

async function prepare(items: UtteranceItem[], draft: PresetDraft): Promise<PreparedBatch> {

  const plans: Plan[] = [];
  const destinations = new Set<string>();
  let overwrites = 0;

  for (const item of items) {
    const preset = draft.collection.items.find((entry) => entry.id === item.presetId);
    if (!preset || !exportReady(preset, item)) {
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
    plans.push({ item, preset, basename, conflict_policy, canonicalOutputDir: folder });
  }
  return { plans, overwrites };
}

/** Only render-affecting inputs enter this key; completed result/status updates are ignored. */
function snapshotKey(draft: PresetDraft | null, items: UtteranceItem[]): string {
  if (!draft) return "";
  return JSON.stringify({
    path: draft.path, fingerprint: draft.fingerprint, presets: draft.collection.items,
    items: items.map(({ id, wavPath, presetId, mode, fps, outputDir, basename,
      conflictChoice, saveAsName }) => ({
      id, wavPath, presetId, mode, fps, outputDir, basename, conflictChoice, saveAsName,
    })),
  });
}

function planKey(draft: PresetDraft, batch: PreparedBatch): string {
  return JSON.stringify(batch.plans.map((plan) => ({
    item: plan.item.id, folder: plan.canonicalOutputDir,
    payload: exportPayload(draft, plan.item, plan.preset, plan.basename, plan.conflict_policy),
  })));
}


export function useBatchUtteranceExport(
  draft: PresetDraft | null, items: UtteranceItem[],
  setItems: Dispatch<SetStateAction<UtteranceItem[]>>,
  onFinished: () => void, enabled: boolean,
) {
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState("");
  const [summary, setSummary] = useState("");
  const [review, setReview] = useState<{ key: string; prepared: PreparedBatch } | null>(null);
  const [reviewError, setReviewError] = useState("");
  const [reviewing, setReviewing] = useState(false);
  const busy = useRef(false);
  const key = snapshotKey(draft, items);

  // The displayed plan is an actual destination preflight, never guessed filenames.
  // Any input change invalidates it immediately, including while a preflight is pending.
  useEffect(() => {
    if (!enabled || running || !draft || !items.length) {
      setReview(null);
      setReviewError("");
      setReviewing(false);
      return;
    }
    let cancelled = false;
    const source = draft;
    const currentItems = [...items];
    setReview(null);
    setReviewError("");
    setReviewing(true);
    void prepare(currentItems, source).then((prepared) => {
      if (!cancelled) setReview({ key, prepared });
    }).catch((error: unknown) => {
      if (!cancelled) setReviewError(error instanceof Error ? error.message : String(error));
    }).finally(() => {
      if (!cancelled) setReviewing(false);
    });
    return () => { cancelled = true; };
  }, [enabled, running, key]);

  const displayed = enabled && review?.key === key ? review.prepared : null;


  async function run() {
    if (busy.current || running || !draft || items.length === 0 || !displayed) return;
    busy.current = true;
    setRunning(true);
    setSummary("");
    setProgress("出力先とプリセットを再確認中…");
    try {
      // Recheck the destination immediately before execution. If it changed, stop;
      // never silently substitute a new basename for the one shown to the user.
      const refreshed = await prepare([...items], draft);
      if (planKey(draft, refreshed) !== planKey(draft, displayed)) {
        setSummary("出力予定が変更されました。新しい予定を確認してから再実行してください。");
        return;
      }
      const { plans, overwrites } = displayed;
      if (overwrites > 0 && !window.confirm(
        `既存のMOVとOTIOを${overwrites}組上書きします。続行しますか？`
      )) {
        setSummary("一括書き出しをキャンセルしました。");
        return;
      }
      let successes = 0;
      let failures = 0;
      for (const [index, plan] of plans.entries()) {
        const item = plan.item;
        setProgress(`書き出し中 ${index + 1} / ${plans.length}：${item.wavPath}`);
        try {
          const result = await post<ExportData>("preset-utterance-export",
            exportPayload(draft, item, plan.preset, plan.basename, plan.conflict_policy));
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
      onFinished();
    } catch (error) {
      setSummary("一括書き出しを開始できません: " +
        (error instanceof Error ? error.message : String(error)));
    } finally {
      setProgress("");
      busy.current = false;
      setRunning(false);
    }
  }

  return { running, progress, summary, run, displayed, reviewing, reviewError };
}
