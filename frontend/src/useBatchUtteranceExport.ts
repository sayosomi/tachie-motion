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

export type BatchConflictChoice = "overwrite" | "rename";

async function prepare(items: UtteranceItem[], draft: PresetDraft,
  naming: BatchNaming, choice: BatchConflictChoice): Promise<PreparedBatch> {
  validateBatchNaming(naming);
  const rawMovieNames = items.map((item, index) => movName(
    naming.movTemplate, index + 1, item.wavPath,
    naming.characterName, naming.projectName,
  ));
  const rawTimelineName = otioName(naming.otioTemplate, naming.projectName);
  // A rename affects the entire generation together. Do not silently mix
  // new and overwritten names, or suffix just one MOV of a combined timeline.
  let resolved: { movieNames: string[]; timelineName: string;
    movies: Destination[]; timeline: Destination } | null = null;
  const limit = choice === "rename" ? 1000 : 1;
  for (let attempt = 0; attempt < limit; attempt++) {
    const suffix = attempt === 0 ? "" : "_" + String(attempt + 1).padStart(3, "0");
    const movieNames = rawMovieNames.map((name) => name + suffix);
    const timelineName = rawTimelineName + suffix;
    await post<{ valid: boolean }>("preset-batch-check-names", {
      basenames: movieNames, timeline_basename: timelineName,
    });
    const movies = await Promise.all(movieNames.map((basename) =>
      post<Destination>("preset-batch-mov-destination", {
        output_dir: naming.outputDir, basename,
      })));
    const timeline = await post<Destination>("preset-combined-otio-destination", {
      output_dir: naming.outputDir, basename: timelineName,
    });
    if (choice === "rename" &&
        (movies.some((dest) => dest.state !== "available") ||
         timeline.state !== "available")) {
      continue;
    }
    resolved = { movieNames, timelineName, movies, timeline };
    break;
  }
  if (!resolved) throw new Error("別名の保存先が見つかりません。ファイル名またはフォルダを変更してください");
  const { movieNames, timelineName, movies, timeline: dest } = resolved;
  const plans: Plan[] = [];
  let overwrites = 0;
  for (const [index, item] of items.entries()) {
    const preset = draft.collection.items.find((entry) => entry.id === item.presetId);
    if (!preset || !exportReady(preset, item)) {
      throw new Error(item.wavPath + " — 口パク・プリセットの設定を確認してください");
    }
    const basename = movieNames[index];
    const destination = movies[index];
    const conflict_policy = allowedDestination(destination, basename);
    if (conflict_policy === "overwrite") overwrites++;
    plans.push({ item, preset, basename, conflict_policy,
      canonicalOutputDir: destination.canonical_output_dir });
  }
  const basename = timelineName;
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
  otherBusy: () => boolean,
) {
  const [conflictChoice, setConflictChoice] = useState<BatchConflictChoice>("overwrite");
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState("");
  const [summary, setSummary] = useState("");
  const [review, setReview] = useState<{ key: string; prepared: PreparedBatch } | null>(null);
  const [reviewError, setReviewError] = useState("");
  const [reviewing, setReviewing] = useState(false);
  const busy = useRef(false);
  const key = snapshotKey(draft, items, naming) + "|" + conflictChoice;

  useEffect(() => {
    if (running) return;
    if (!enabled || !draft || !items.length) {
      setReview(null); setReviewError(""); setReviewing(false);
      return;
    }
    let cancelled = false;
    setReview(null); setReviewError(""); setReviewing(true);
    void prepare([...items], draft, naming, conflictChoice).then((prepared) => {
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
    if (busy.current || otherBusy() || running || !draft || items.length === 0 || !displayed) return;
    busy.current = true;
    setRunning(true);
    setSummary("");
    setProgress("出力先と保存名を再確認中…");
    let sessionId: string | null = null;
    try {
      const refreshed = await prepare([...items], draft, naming, conflictChoice);
      if (planKey(draft, refreshed) !== planKey(draft, displayed)) {
        setSummary("出力予定が変更されました。新しい予定を確認してから再実行してください。");
        return;
      }
      const { plans, timeline, overwrites } = displayed;
      if (overwrites && !window.confirm(
        "既存のMOV・全体OTIOを合計" + overwrites + "件上書きします。続行しますか？"
      )) {
        setSummary("一括書き出しをキャンセルしました。");
        return;
      }
      const session = await post<{ batch_id: string }>("preset-batch-start", {
        output_dir: timeline.canonicalOutputDir,
        timeline_basename: timeline.basename,
        timeline_policy: timeline.conflict_policy,
        entries: plans.map((plan) => ({
          basename: plan.basename, wav: plan.item.wavPath,
          source_identity: plan.item.wav.source_identity, fps: plan.item.fps,
          samples: plan.item.wav.samples, sample_rate: plan.item.wav.sample_rate,
          conflict_policy: plan.conflict_policy,
        })),
      });
      sessionId = session.batch_id;
      if (!sessionId) throw new Error("一括書き出しのセッションを開始できません");
      let successes = 0;
      let failures = 0;
      const complete: { basename: string; frames: number; fps: number;
        samples: number; sample_rate: number }[] = [];
      const notes: string[] = [];
      const stagedResults: { id: string; result: MovieResult }[] = [];
      for (const [index, plan] of plans.entries()) {
        const item = plan.item;
        setProgress("MOVを書き出し中 " + (index + 1) + " / " + plans.length +
          "：" + plan.basename + ".mov");
        try {
          const payload = exportPayload(draft, {
            ...item, outputDir: plan.canonicalOutputDir,
          }, plan.preset, plan.basename, plan.conflict_policy);
          const result = await post<MovieResult>("preset-batch-mov-export", {
            ...payload, batch_id: sessionId, batch_index: index,
          });
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
          stagedResults.push({ id: item.id, result });
        } catch (error) {
          failures++;
          setItems((previous) => previous.map((entry) => entry.id === item.id
            ? { ...entry, result: null,
                error: error instanceof Error ? error.message : String(error) } : entry));
        }
      }
      if (failures) {
        setSummary("MOVを一時生成しましたが" + failures +
          "件失敗したため、旧MOV・OTIOは変更していません。失敗した項目を確認してください。");
        return;
      }
      setProgress("全体OTIOを書き出し中：" + timeline.basename + ".otio");
      const done = await post<TimelineResult>("preset-combined-otio", {
        output_dir: timeline.canonicalOutputDir, basename: timeline.basename,
        conflict_policy: timeline.conflict_policy, entries: complete,
        batch_id: sessionId,
      });
      if (done.otio !== timeline.canonicalOutputDir + "/" + timeline.basename + ".otio" ||
          done.entries !== complete.length) {
        throw new Error("全体OTIOの保存先が予定と異なります");
      }
      if (done.warning) notes.push(done.warning);
      // Nothing was published during MOV rendering. Mark successful only
      // after the whole generation (including OTIO) has committed.
      setItems((previous) => previous.map((entry) => {
        const saved = stagedResults.find((record) => record.id === entry.id);
        return saved ? {
          ...entry, result: { mov: saved.result.mov, otio: "",
            frames: saved.result.frames, sample_count: saved.result.sample_count },
          error: "",
        } : entry;
      }));
      setSummary("一括書き出し完了：MOV " + successes + "件／全体OTIO " + done.otio +
        (notes.length ? " ／ 注意：" + notes.join(" ") : ""));
      onFinished();
    } catch (error) {
      setSummary("一括書き出しを完了できませんでした。既存ファイルの状態を確認してください：" +
        (error instanceof Error ? error.message : String(error)));
    } finally {
      // Release the server-wide lease on every completion/cancel/failure path.
      // A stale tab cannot release a different session's unpredictable token.
      if (sessionId) {
        try {
          await post<{ released: boolean }>("preset-batch-cancel", { batch_id: sessionId });
        } catch {
          setSummary((previous) => previous +
            " ／ サーバー側の一括ロック解除を確認できません。再実行する前に状態を確認してください。");
        }
      }
      setProgress("");
      busy.current = false;
      setRunning(false);
    }
  }
  return { running, isBusy: () => busy.current, progress, summary, run,
    displayed, reviewing, reviewError, conflictChoice, setConflictChoice };
}
