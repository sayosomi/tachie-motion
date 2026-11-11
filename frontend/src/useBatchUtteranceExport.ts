import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { PresetDraft } from "./presetDraftStorage";
import type { UnifiedPreset } from "./presetModel";
import { exportPayload, exportReady } from "./utteranceExportRequest";
import { movName, otioName, validateBatchNaming, type BatchNaming } from "./nameTemplate";
import type { UtteranceItem } from "./utteranceItems";

type Destination = {
  state: "available" | "complete" | "unsafe" | "recovery_required";
  canonical_output_dir: string;
};
type Conflict = "overwrite" | "error";
export type Plan = {
  item: UtteranceItem;
  preset: UnifiedPreset;
  basename: string;
  conflict_policy: Conflict;
  canonicalOutputDir: string;
};
export type TimelinePlan = {
  basename: string;
  conflict_policy: Conflict;
  canonicalOutputDir: string;
};
export type PreparedBatch = {
  plans: Plan[];
  timeline: TimelinePlan;
  overwrites: number;
};

type MovieResult = {
  mov: string;
  frames: number;
  sample_count: number;
  sample_rate: number;
  warning?: string;
};
type TimelineResult = { otio: string; entries: number; warning?: string };

async function post<T>(route: string, body: object): Promise<T> {
  const response = await fetch("/api/" + route, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await response.json() as T & { detail?: string };
  if (!response.ok) throw new Error(result.detail || "HTTP " + response.status);
  return result;
}

function allowedDestination(response: Destination, name: string): Conflict {
  if (response.state === "complete") return "overwrite";
  if (response.state === "available") return "error";
  throw new Error("出力先の安全確認に失敗しました：" + name + " (" + response.state + ")");
}

async function prepare(items: UtteranceItem[], draft: PresetDraft,
  naming: BatchNaming): Promise<PreparedBatch> {
  validateBatchNaming(naming);
  const plans: Plan[] = [];
  const used = new Set<string>();
  let overwrites = 0;
  for (const [index, item] of items.entries()) {
    const preset = draft.collection.items.find((entry) => entry.id === item.presetId);
    if (!preset || !exportReady(preset, item)) {
      throw new Error(item.wavPath + " — 口パク・プリセットの設定を確認してください");
    }
    const basename = movName(naming.movTemplate, index + 1, item.wavPath,
      naming.characterName, naming.projectName);
    const key = basename.normalize("NFC").toLocaleLowerCase();
    if (used.has(key)) throw new Error("MOVの保存名が重複します：" + basename);
    used.add(key);
    const destination = await post<Destination>("preset-batch-mov-destination", {
      output_dir: naming.outputDir, basename,
    });
    const conflict_policy = allowedDestination(destination, basename);
    if (conflict_policy === "overwrite") overwrites++;
    plans.push({ item, preset, basename, conflict_policy,
      canonicalOutputDir: destination.canonical_output_dir });
  }
  const basename = otioName(naming.otioTemplate, naming.projectName);
  const dest = await post<Destination>("preset-combined-otio-destination", {
    output_dir: naming.outputDir, basename,
  });
  const policy = allowedDestination(dest, basename);
  if (policy === "overwrite") overwrites++;
  if (plans.some((plan) => plan.canonicalOutputDir !== dest.canonical_output_dir)) {
    throw new Error("一括MOVと全体OTIOの出力先が一致しません");
  }
  return { plans, overwrites, timeline: {
    basename, conflict_policy: policy, canonicalOutputDir: dest.canonical_output_dir,
  } };
}

/** Render-affecting properties only; prior export status does not invalidate the plan. */
function snapshotKey(draft: PresetDraft | null, items: UtteranceItem[],
  naming: BatchNaming): string {
  if (!draft) return "";
  return JSON.stringify({
    psd: draft.path, fingerprint: draft.fingerprint, presets: draft.collection.items,
    naming, items: items.map((item) => ({
      id: item.id, wavPath: item.wavPath, wav: item.wav, presetId: item.presetId,
      mode: item.mode, fps: item.fps,
    })),
  });
}

function planKey(draft: PresetDraft, batch: PreparedBatch): string {
  return JSON.stringify({
    timeline: batch.timeline,
    plans: batch.plans.map((plan) => ({
      id: plan.item.id, folder: plan.canonicalOutputDir,
      payload: exportPayload(draft, { ...plan.item, outputDir: plan.canonicalOutputDir },
        plan.preset, plan.basename, plan.conflict_policy),
    })),
  });
}

export function useBatchUtteranceExport(
  draft: PresetDraft | null, items: UtteranceItem[],
  setItems: Dispatch<SetStateAction<UtteranceItem[]>>,
  onFinished: () => void, enabled: boolean, naming: BatchNaming,
) {
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState("");
  const [summary, setSummary] = useState("");
  const [review, setReview] = useState<{ key: string; prepared: PreparedBatch } | null>(null);
  const [reviewError, setReviewError] = useState("");
  const [reviewing, setReviewing] = useState(false);
  const busy = useRef(false);
  const key = snapshotKey(draft, items, naming);

  useEffect(() => {
    if (running) return;
    if (!enabled || !draft || !items.length) {
      setReview(null); setReviewError(""); setReviewing(false);
      return;
    }
    let cancelled = false;
    setReview(null); setReviewError(""); setReviewing(true);
    void prepare([...items], draft, naming).then((prepared) => {
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
    setProgress("出力先と保存名を再確認中…");
    try {
      const refreshed = await prepare([...items], draft, naming);
      if (planKey(draft, refreshed) !== planKey(draft, displayed)) {
        setSummary("出力予定が変更されました。新しい予定を確認してから再実行してください。");
        return;
      }
      const { plans, timeline, overwrites } = displayed;
      if (overwrites && !window.confirm(
        "既存のMOV／全体OTIOを" + overwrites + "件上書きします。続行しますか？"
      )) {
        setSummary("一括書き出しをキャンセルしました。");
        return;
      }
      let successes = 0;
      let failures = 0;
      const complete: { basename: string; frames: number; fps: number;
        samples: number; sample_rate: number }[] = [];
      const notes: string[] = [];
      for (const [index, plan] of plans.entries()) {
        const item = plan.item;
        setProgress("MOVを書き出し中 " + (index + 1) + " / " + plans.length +
          "：" + plan.basename + ".mov");
        try {
          const payload = exportPayload(draft, {
            ...item, outputDir: plan.canonicalOutputDir,
          }, plan.preset, plan.basename, plan.conflict_policy);
          const result = await post<MovieResult>("preset-batch-mov-export", payload);
          const expected = plan.canonicalOutputDir + "/" + plan.basename + ".mov";
          if (result.mov !== expected ||
              result.sample_count !== item.wav.samples ||
              result.sample_rate !== item.wav.sample_rate ||
              !Number.isSafeInteger(result.frames) || result.frames <= 0) {
            throw new Error("書き出したMOVの確認結果が予定と一致しません");
          }
          complete.push({ basename: plan.basename, frames: result.frames,
            fps: item.fps, samples: result.sample_count, sample_rate: result.sample_rate });
          if (result.warning) notes.push(result.warning);
          successes++;
          setItems((previous) => previous.map((entry) => entry.id === item.id
            ? { ...entry, result: { mov: result.mov, otio: "",
                frames: result.frames, sample_count: result.sample_count }, error: "" } : entry));
        } catch (error) {
          failures++;
          setItems((previous) => previous.map((entry) => entry.id === item.id
            ? { ...entry, result: null,
                error: error instanceof Error ? error.message : String(error) } : entry));
        }
      }
      if (failures) {
        setSummary("MOV成功 " + successes + "件／失敗 " + failures +
          "件。全体OTIOは生成していません。失敗した項目を確認してください。");
        return;
      }
      setProgress("全体OTIOを書き出し中：" + timeline.basename + ".otio");
      const done = await post<TimelineResult>("preset-combined-otio", {
        output_dir: timeline.canonicalOutputDir, basename: timeline.basename,
        conflict_policy: timeline.conflict_policy, entries: complete,
      });
      if (done.otio !== timeline.canonicalOutputDir + "/" + timeline.basename + ".otio" ||
          done.entries !== complete.length) {
        throw new Error("全体OTIOの保存先が予定と異なります");
      }
      if (done.warning) notes.push(done.warning);
      setSummary("一括書き出し完了：MOV " + successes + "件／全体OTIO " + done.otio +
        (notes.length ? " ／ 注意：" + notes.join(" ") : ""));
      onFinished();
    } catch (error) {
      setSummary("全体OTIOを生成できませんでした。MOVは既に作成された可能性があります：" +
        (error instanceof Error ? error.message : String(error)));
    } finally {
      setProgress("");
      busy.current = false;
      setRunning(false);
    }
  }
  return { running, isBusy: () => busy.current, progress, summary, run,
    displayed, reviewing, reviewError };
}
