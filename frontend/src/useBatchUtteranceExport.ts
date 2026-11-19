import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { PresetDraft } from "./presetDraftStorage";
import type { UnifiedPreset } from "./presetModel";
import { effectiveLabSourceIdentity, exportPayload, exportReadinessError } from "./utteranceExportRequest";
import { movName, otioName, suffixedOutputName, validateBatchNaming, type BatchNaming } from "./nameTemplate";
import { wavFilename, type UtteranceItem } from "./utteranceItems";
import type { LabInfo } from "./useLabStatus";

type Destination = {
  state: "available" | "complete" | "unsafe" | "recovery_required";
  canonical_output_dir: string;
  /** Server's conservative read-only scan; rechecked at actual batch start. */
  other_otio_present?: boolean;
};
type Conflict = "overwrite" | "error";
export type Plan = {
  item: UtteranceItem;
  preset: UnifiedPreset;
  basename: string;
  conflict_policy: Conflict;
  canonicalOutputDir: string;
  labSourceIdentity: string | null;
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
type ExportProgressCallbacks = {
  begin: (token: string, names: string[]) => void;
  settle: (outcome: "success" | "failed" | "cancelled", detail?: string) => void;
  uncertain: (detail: string) => void;
  terminalPhase: "success" | "failed" | "cancelled" | null;
};
const cancelledByServer = (error: unknown) =>
  error instanceof Error && error.message.includes("書き出しをキャンセルしました");


async function prepare(items: UtteranceItem[], draft: PresetDraft,
  naming: BatchNaming, choice: BatchConflictChoice,
  labStatuses: Record<string, LabInfo>): Promise<PreparedBatch> {
  validateBatchNaming(naming);
  const rawMovieNames = items.map((item, index) => movName(
    naming.movTemplate, index + 1, item.wavPath,
    naming.characterName, naming.projectName,
  ));
  const rawTimelineName = otioName(naming.otioTemplate, naming.projectName);
  // Catch exact duplicates locally even when a server/mock responds "valid".
  // Python NFC+casefold remains the authoritative cross-platform check.
  if (new Set([...rawMovieNames, rawTimelineName]).size !==
      rawMovieNames.length + 1) {
    throw new Error("MOVの保存名が重複します");
  }
  // A rename affects the entire generation together. Do not silently mix
  // new and overwritten names, or suffix just one MOV of a combined timeline.
  let resolved: { movieNames: string[]; timelineName: string;
    movies: Destination[]; timeline: Destination } | null = null;
  const limit = choice === "rename" ? 1000 : 1;
  for (let attempt = 0; attempt < limit; attempt++) {
    const suffix = attempt === 0 ? "" : "_" + String(attempt + 1).padStart(3, "0");
    const movieNames = rawMovieNames.map((name) => suffixedOutputName(name, suffix));
    const timelineName = suffixedOutputName(rawTimelineName, suffix);
    // Truncation can collapse originally distinct names; the server also
    // rejects Unicode NFC+casefold collisions before any export begins.
    if (new Set([...movieNames, timelineName]).size !== movieNames.length + 1) {
      throw new Error("MOVの保存名が重複します（別名の短縮後）");
    }
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
    const reason = exportReadinessError(preset, item, labStatuses[item.id], draft.collection);
    if (reason || !preset) {
      throw new Error(`${index + 1}番 ${item.wavPath} — ${reason ?? "プリセットが見つかりません。"}`);
    }
    const basename = movieNames[index];
    const destination = movies[index];
    const conflict_policy = allowedDestination(destination, basename);
    if (conflict_policy === "overwrite") overwrites++;
    plans.push({ item, preset, basename, conflict_policy,
      canonicalOutputDir: destination.canonical_output_dir,
      labSourceIdentity: effectiveLabSourceIdentity(
        item, preset, labStatuses[item.id]?.source_identity,
      ) });
  }
  const basename = timelineName;
  const policy = allowedDestination(dest, basename);
  if (policy === "overwrite") overwrites++;
  if (plans.some((plan) => plan.canonicalOutputDir !== dest.canonical_output_dir)) {
    throw new Error("一括MOVと全体OTIOの出力先が一致しません");
  }
  // Match BatchCoordinator.start: another OTIO might reference a MOV being
  // replaced. Show this before enabling the button, without weakening the
  // server's second check when the folder changes between preview and start.
  if (plans.some((plan) => plan.conflict_policy === "overwrite") &&
      dest.other_otio_present) {
    throw new Error(
      "別のOTIOが同じフォルダにあります。上書き対象MOVを参照している可能性があるため、" +
      "保護のため停止します。「別名で保存」を選ぶか、別の出力フォルダを指定してください。"
    );
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
    blinkTiming: draft.collection.blinkTiming, motionGroups: draft.collection.motionGroups,
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
        plan.preset, plan.basename, plan.conflict_policy, plan.labSourceIdentity),
    })),
  });
}

export function useBatchUtteranceExport(
  draft: PresetDraft | null, items: UtteranceItem[],
  setItems: Dispatch<SetStateAction<UtteranceItem[]>>,
  onFinished: () => void, enabled: boolean, naming: BatchNaming,
  otherBusy: () => boolean, labStatuses: Record<string, LabInfo>,
  overlay: ExportProgressCallbacks,
) {
  const [conflictChoice, setConflictChoice] = useState<BatchConflictChoice>("overwrite");
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState("");
  const [summary, setSummary] = useState("");
  const [review, setReview] = useState<{ key: string; prepared: PreparedBatch } | null>(null);
  const [reviewError, setReviewError] = useState("");
  const [reviewing, setReviewing] = useState(false);
  const busy = useRef(false);
  const uncertainRun = useRef(false);
  const [reconcileVersion, setReconcileVersion] = useState(0);
  useEffect(() => {
    if (!uncertainRun.current || !overlay.terminalPhase) return;
    // A lost response never releases the edit lock. Only a confirmed
    // terminal server status can conclude an uncertain batch.
    uncertainRun.current = false;
    busy.current = false;
    setRunning(false);
    setSummary(overlay.terminalPhase === "success"
      ? "サーバーで完了を確認しました。通信が切れたため出力フォルダの成果物をご確認ください。"
      : overlay.terminalPhase === "cancelled"
        ? "サーバーが中断を確認しました。旧ファイルは保護されています。"
        : "書き出しの終了を確認しました。出力先・復旧情報をご確認ください。");
  }, [overlay.terminalPhase, reconcileVersion]);
  const key = snapshotKey(draft, items, naming) + "|" + conflictChoice +
    "|" + JSON.stringify(items.map((item) => [
      item.id, item.mode === "aiueo"
        ? [labStatuses[item.id]?.status, labStatuses[item.id]?.source_identity] : null,
    ]));

  useEffect(() => {
    if (running) return;
    if (!enabled || !draft || !items.length) {
      setReview(null); setReviewError(""); setReviewing(false);
      return;
    }
    let cancelled = false;
    setReview(null); setReviewError(""); setReviewing(true);
    void prepare([...items], draft, naming, conflictChoice, labStatuses).then((prepared) => {
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
    uncertainRun.current = false;
    setRunning(true);
    setSummary("");
    setProgress("出力先と保存名を再確認中…");
    let sessionId: string | null = null;
    let transportUnknown = false;
    let outcome: "success" | "failed" | "cancelled" | null = null;
    let outcomeDetail = "";
    try {
      const refreshed = await prepare([...items], draft, naming, conflictChoice, labStatuses);
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
      // Client-side UUID survives a lost batch-start response.
      const preferredToken = crypto.randomUUID();
      await post<{ registered: boolean }>("export-progress-reserve", {
        token: preferredToken, kind: "batch", total: plans.length,
      });
      sessionId = preferredToken;
      overlay.begin(sessionId, plans.map((plan) => wavFilename(plan.item.wavPath)));
      const session = await post<{ batch_id: string }>("preset-batch-start", {
        progress_id: sessionId,
        output_dir: timeline.canonicalOutputDir,
        timeline_basename: timeline.basename,
        timeline_policy: timeline.conflict_policy,
        entries: plans.map((plan) => ({
          basename: plan.basename, wav: plan.item.wavPath,
          source_identity: plan.item.wav.source_identity,
          lab_source_identity: plan.labSourceIdentity, fps: plan.item.fps,
          samples: plan.item.wav.samples, sample_rate: plan.item.wav.sample_rate,
          conflict_policy: plan.conflict_policy,
        })),
      });
      if (!session.batch_id) throw new Error("一括書き出しのセッションを開始できません");
      if (sessionId !== session.batch_id) {
        // Older mocked sessions return a server-generated ID.
        sessionId = session.batch_id;
        overlay.begin(sessionId, plans.map((plan) => wavFilename(plan.item.wavPath)));
      }
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
          }, plan.preset, plan.basename, plan.conflict_policy,
            plan.labSourceIdentity);
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
          // A broken connection does not establish that the media worker
          // stopped. Abort the entire client loop; never render the next WAV.
          if (error instanceof TypeError ||
              (error instanceof DOMException && error.name === "AbortError"))
            throw error;
          if (cancelledByServer(error)) {
            outcome = "cancelled";
            setSummary("一括書き出しをキャンセルしました。旧MOV・OTIOは変更していません。");
            return;
          }
          failures++;
          setItems((previous) => previous.map((entry) => entry.id === item.id
            ? { ...entry, result: null,
                error: error instanceof Error ? error.message : String(error) } : entry));
        }
      }
      if (failures) {
        outcome = "failed";
        outcomeDetail = failures + "件のMOV生成に失敗。旧MOV・OTIOは変更していません。";
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
      outcome = "success";
      setSummary("一括書き出し完了：MOV " + successes + "件／全体OTIO " + done.otio +
        (notes.length ? " ／ 注意：" + notes.join(" ") : ""));
      onFinished();
    } catch (error) {
      if (sessionId && (error instanceof TypeError ||
          (error instanceof DOMException && error.name === "AbortError"))) {
        transportUnknown = true;
        uncertainRun.current = true;
        setReconcileVersion((value) => value + 1);
        overlay.uncertain("通信が切れました。サーバーの停止・公開状態を確認中です。");
        setSummary("書き出し結果は未確定です。サーバーの確認まで再実行できません。");
        // The server finishes cancellation independently after its worker
        // exits. Failure to deliver this request keeps the UI locked.
        try { await post("export-cancel", { token: sessionId }); }
        catch { /* Progress polling resumes after connectivity returns. */ }
        return;
      }
      outcome = cancelledByServer(error) ? "cancelled" : "failed";
      outcomeDetail = error instanceof Error ? error.message : String(error);
      setSummary(outcome === "cancelled"
        ? "一括書き出しをキャンセルしました。旧MOV・OTIOは変更していません。"
        : "一括書き出しを完了できませんでした。既存ファイルの状態を確認してください：" +
          outcomeDetail);
    } finally {
      // Release the server-wide lease on every completion/cancel/failure path.
      // A stale tab cannot release a different session's unpredictable token.
      if (sessionId && !transportUnknown) {
        try {
          const release = await post<{ released: boolean }>("preset-batch-cancel",
            { batch_id: sessionId });
          if (!release.released && outcome !== "success") {
            // The independent cancel request may have released this same
            // lease before the originating request returned.
            const reply = await fetch("/api/export-progress/" +
              encodeURIComponent(sessionId));
            const state = reply.ok ? await reply.json() as { status: string } : null;
            if (state?.status !== "cancelled" && state?.status !== "failed")
              throw new Error("一括処理のロック解除を確認できません");
          }
          if (outcome) overlay.settle(outcome, outcomeDetail);
        } catch {
          overlay.settle("failed",
            "サーバー側の一括処理の解除を確認できません。出力先の状態を確認してください。");
          setSummary((previous) => previous +
            " ／ サーバー側の一括ロック解除を確認できません。再実行する前に状態を確認してください。");
        }
      }
      if (!transportUnknown) {
        setProgress("");
        busy.current = false;
        setRunning(false);
      }
    }
  }
  return { running, isBusy: () => busy.current, progress, summary, run,
    displayed, reviewing, reviewError, conflictChoice, setConflictChoice };
}
