import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { PresetDraft } from "./presetDraftStorage";
import type { UnifiedPreset } from "./presetModel";
import { blinkFrames } from "./blinkTiming";
import { effectiveLabSourceIdentity, exportPayload, exportReadinessError } from "./utteranceExportRequest";
import { movName, otioName, suffixedOutputName, validateBatchNaming, type BatchNaming } from "./nameTemplate";
import { wavFilename, type UtteranceItem, type IdleAfter } from "./utteranceItems";
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
  suggestedBasename: string;
  reuse: boolean;
  reuseReason: string;
  conflict_policy: Conflict;
  canonicalOutputDir: string;
  labSourceIdentity: string | null;
};
export type TimelinePlan = {
  basename: string;
  conflict_policy: Conflict;
  canonicalOutputDir: string;
};
export type IdlePlan = {
  item: UtteranceItem;
  idle: IdleAfter;
  preset: UnifiedPreset;
  basename: string;
  conflict_policy: Conflict;
  canonicalOutputDir: string;
};
export type BatchSegment =
  | { kind: "speech"; plan: Plan }
  | { kind: "idle"; plan: IdlePlan };
export type PreparedBatch = {
  plans: Plan[];
  sequence: BatchSegment[];
  timeline: TimelinePlan;
  overwrites: number;
};

type MovieResult = {
  mov: string;
  frames: number;
  sample_count: number;
  sample_rate: number;
  reused?: boolean;
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


function idlePayload(draft: PresetDraft, psdIdentity: string, plan: IdlePlan) {
  const { preset, idle } = plan;
  const timing = preset.blinkEnabled ? blinkFrames(draft.collection.blinkTiming, idle.fps) : null;
  if (preset.blinkEnabled && (!timing ||
    !draft.collection.motionGroups?.eyes?.length ||
    !preset.eyes?.closed.some((entry) => entry.visible))) {
    throw new Error("待機プリセットの瞬き設定が未完了です");
  }
  return {
    psd: draft.path, fingerprint: draft.fingerprint,
    source_identity: psdIdentity, layers: preset.base,
    frame_count: idle.frames, fps: idle.fps,
    blink_enabled: preset.blinkEnabled,
    eyes: preset.blinkEnabled ? preset.eyes ?? null : null,
    eye_groups: preset.blinkEnabled ? draft.collection.motionGroups?.eyes ?? null : null,
    blink_timing: timing, output_dir: plan.canonicalOutputDir,
    basename: plan.basename, conflict_policy: plan.conflict_policy,
  };
}

async function prepare(items: UtteranceItem[], draft: PresetDraft,
  naming: BatchNaming, choice: BatchConflictChoice,
  labStatuses: Record<string, LabInfo>, psdIdentity: string | null): Promise<PreparedBatch> {
  validateBatchNaming(naming);
  const hasIdle = items.some((item) => !!item.idleAfter);
  if (items.at(-1)?.idleAfter) {
    throw new Error("末尾のセリフに待機が設定されています。待機を削除するか順序を変更してください");
  }
  if (hasIdle && !psdIdentity) throw new Error("待機MOVに必要なPSD同一性が未確認です");
  const rawMovieNames = items.map((item, index) => movName(
    naming.movTemplate, index + 1, item.wavPath,
    naming.characterName, naming.projectName,
  ));
  const rawTimelineName = otioName(naming.otioTemplate, naming.projectName);
  const rawIdleNames = items.map((item, index) => item.idleAfter
    ? suffixedOutputName(rawMovieNames[index], "_待機") : null);
  const rawAllNames = rawMovieNames.flatMap((name, index) =>
    rawIdleNames[index] ? [name, rawIdleNames[index]!] : [name]);
  // Catch exact duplicates locally even when a server/mock responds "valid".
  // Python NFC+casefold remains the authoritative cross-platform check.
  if (new Set([...rawAllNames, rawTimelineName]).size !==
      rawAllNames.length + 1) {
    throw new Error("MOVの保存名が重複します");
  }
  const inputs = items.map((item, index) => {
    const preset = draft.collection.items.find((entry) => entry.id === item.presetId);
    const reason = exportReadinessError(preset, item, labStatuses[item.id], draft.collection);
    if (reason || !preset) {
      throw new Error(`${index + 1}番 ${item.wavPath} — ${reason ?? "プリセットが見つかりません。"}`);
    }
    const labSourceIdentity = effectiveLabSourceIdentity(
      item, preset, labStatuses[item.id]?.source_identity,
      (item.presetChanges ?? []).map((point) => draft.collection.items.find(
        (value) => value.id === point.presetId)).filter(
        (value): value is UnifiedPreset => !!value),
    );
    return { item, preset, labSourceIdentity };
  });
  // Reused MOVs keep their original public basenames. This browser preflight
  // is advisory; server start and media checks repeat all safety decisions.
  const hints = choice === "overwrite" && !hasIdle ? await Promise.all(inputs.map(async (input, index) =>
    post<{ basename: string; reuse: boolean; reason?: string }>("preset-batch-reuse-candidate", {
      timeline_basename: rawTimelineName, item_id: input.item.id,
      suggested_basename: rawMovieNames[index],
      render: exportPayload(draft, { ...input.item, outputDir: naming.outputDir },
        input.preset, rawMovieNames[index], "overwrite", input.labSourceIdentity),
    })
  )) : rawMovieNames.map((basename) => ({ basename, reuse: false,
    reason: "別名保存のため全件新規生成" }));
  const preferredMovieNames = items.flatMap((item, index) => [
    hints[index].basename, ...(item.idleAfter ? [rawIdleNames[index]!] : []),
  ]);
  // A rename affects the entire generation together. Do not silently mix
  // new and overwritten names, or suffix just one MOV of a combined timeline.
  let resolved: { movieNames: string[]; timelineName: string;
    movies: Destination[]; timeline: Destination } | null = null;
  const limit = choice === "rename" ? 1000 : 1;
  for (let attempt = 0; attempt < limit; attempt++) {
    const suffix = attempt === 0 ? "" : "_" + String(attempt + 1).padStart(3, "0");
    const movieNames = preferredMovieNames.map((name) => suffixedOutputName(name, suffix));
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
  const sequence: BatchSegment[] = [];
  let overwrites = 0;
  let cursor = 0;
  for (const [index, input] of inputs.entries()) {
    const basename = movieNames[cursor];
    const destination = movies[cursor++];
    const conflict_policy = allowedDestination(destination, basename);
    const reuse = hints[index].reuse && choice === "overwrite" && !hasIdle &&
      basename === hints[index].basename && conflict_policy === "overwrite";
    if (conflict_policy === "overwrite" && !reuse) overwrites++;
    const plan: Plan = { ...input, basename, suggestedBasename: rawMovieNames[index],
      reuse, reuseReason: hints[index].reason ?? (reuse
        ? "保存済みMOVを検証済み" : "検証可能な再利用条件がないため生成"),
      conflict_policy, canonicalOutputDir: destination.canonical_output_dir,
      labSourceIdentity: input.labSourceIdentity };
    plans.push(plan);
    sequence.push({ kind: "speech", plan });
    const idle = input.item.idleAfter;
    if (idle) {
      if (index === items.length - 1 || !Number.isSafeInteger(idle.frames) ||
          idle.frames < 1 || idle.frames > 216000 ||
          ![24, 30, 60].includes(idle.fps)) {
        throw new Error("待機区間の順序・長さ・FPSが不正です");
      }
      const preset = draft.collection.items.find((value) => value.id === idle.presetId);
      if (!preset) throw new Error("待機区間のプリセットが見つかりません");
      const name = movieNames[cursor];
      const target = movies[cursor++];
      const idlePolicy = allowedDestination(target, name);
      if (idlePolicy === "overwrite") overwrites++;
      const waiting: IdlePlan = {
        item: input.item, idle, preset, basename: name,
        conflict_policy: idlePolicy, canonicalOutputDir: target.canonical_output_dir,
      };
      idlePayload(draft, psdIdentity!, waiting);
      sequence.push({ kind: "idle", plan: waiting });
    }
  }
  const basename = timelineName;
  const policy = allowedDestination(dest, basename);
  if (policy === "overwrite") overwrites++;
  if (sequence.some(({ plan }) => plan.canonicalOutputDir !== dest.canonical_output_dir)) {
    throw new Error("一括MOVと全体OTIOの出力先が一致しません");
  }
  // Match BatchCoordinator.start: another OTIO might reference a MOV being
  // replaced. Show this before enabling the button, without weakening the
  // server's second check when the folder changes between preview and start.
  if (sequence.some((segment) => segment.plan.conflict_policy === "overwrite" &&
        (segment.kind === "idle" || !segment.plan.reuse)) &&
      dest.other_otio_present) {
    throw new Error(
      "別のOTIOが同じフォルダにあります。上書き対象MOVを参照している可能性があるため、" +
      "保護のため停止します。「別名で保存」を選ぶか、別の出力フォルダを指定してください。"
    );
  }
  return { plans, sequence, overwrites, timeline: {
    basename, conflict_policy: policy, canonicalOutputDir: dest.canonical_output_dir,
  } };
}

/** Render-affecting properties only; prior export status does not invalidate the plan. */
function snapshotKey(draft: PresetDraft | null, items: UtteranceItem[],
  naming: BatchNaming, psdIdentity: string | null): string {
  if (!draft) return "";
  return JSON.stringify({
    psd: draft.path, fingerprint: draft.fingerprint, psdIdentity,
    presets: draft.collection.items,
    blinkTiming: draft.collection.blinkTiming, motionGroups: draft.collection.motionGroups,
    naming, items: items.map((item) => ({
      id: item.id, wavPath: item.wavPath, wav: item.wav, presetId: item.presetId,
      presetChanges: item.presetChanges ?? [], idleAfter: item.idleAfter ?? null,
      mode: item.mode, fps: item.fps,
    })),
  });
}

function planKey(draft: PresetDraft, batch: PreparedBatch, psdIdentity: string | null): string {
  return JSON.stringify({
    timeline: batch.timeline,
    sequence: batch.sequence.map((segment) => segment.kind === "speech" ? ({
      kind: "speech", id: segment.plan.item.id,
      folder: segment.plan.canonicalOutputDir, reuse: segment.plan.reuse,
      payload: exportPayload(draft, {
        ...segment.plan.item, outputDir: segment.plan.canonicalOutputDir,
      }, segment.plan.preset, segment.plan.basename,
        segment.plan.conflict_policy, segment.plan.labSourceIdentity),
    }) : ({
      kind: "idle", id: segment.plan.idle.id,
      payload: idlePayload(draft, psdIdentity!, segment.plan),
    })),
  });
}

export function useBatchUtteranceExport(
  draft: PresetDraft | null, items: UtteranceItem[],
  setItems: Dispatch<SetStateAction<UtteranceItem[]>>,
  onFinished: () => void, enabled: boolean, naming: BatchNaming,
  otherBusy: () => boolean, labStatuses: Record<string, LabInfo>,
  psdIdentity: string | null, overlay: ExportProgressCallbacks,
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
  const key = snapshotKey(draft, items, naming, psdIdentity) + "|" + conflictChoice +
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
    void prepare([...items], draft, naming, conflictChoice, labStatuses, psdIdentity).then((prepared) => {
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
      const refreshed = await prepare([...items], draft, naming, conflictChoice, labStatuses, psdIdentity);
      if (planKey(draft, refreshed, psdIdentity) !==
          planKey(draft, displayed, psdIdentity)) {
        setSummary("出力予定が変更されました。新しい予定を確認してから再実行してください。");
        return;
      }
      const { plans, sequence, timeline, overwrites } = displayed;
      if (overwrites && !window.confirm(
        "既存のMOV・全体OTIOを合計" + overwrites + "件上書きします。続行しますか？"
      )) {
        setSummary("一括書き出しをキャンセルしました。");
        return;
      }
      // Client-side UUID survives a lost batch-start response.
      const preferredToken = crypto.randomUUID();
      await post<{ registered: boolean }>("export-progress-reserve", {
        token: preferredToken, kind: "batch", total: sequence.length,
      });
      sessionId = preferredToken;
      overlay.begin(sessionId, sequence.map((segment) => segment.kind === "speech"
         ? wavFilename(segment.plan.item.wavPath) : "待機 " + segment.plan.basename));
      const session = await post<{ batch_id: string }>("preset-batch-start", {
        progress_id: sessionId,
        output_dir: timeline.canonicalOutputDir,
        timeline_basename: timeline.basename,
        timeline_policy: timeline.conflict_policy,
        entries: sequence.map((segment) => segment.kind === "speech" ? ({
          item_id: segment.plan.item.id, reuse: segment.plan.reuse,
          basename: segment.plan.basename, wav: segment.plan.item.wavPath,
          source_identity: segment.plan.item.wav.source_identity,
          lab_source_identity: segment.plan.labSourceIdentity,
          fps: segment.plan.item.fps, samples: segment.plan.item.wav.samples,
          sample_rate: segment.plan.item.wav.sample_rate,
          conflict_policy: segment.plan.conflict_policy,
        }) : ({
          kind: "idle", item_id: segment.plan.idle.id, reuse: false,
          basename: segment.plan.basename, psd: draft.path,
          fingerprint: draft.fingerprint, source_identity: psdIdentity!,
          fps: segment.plan.idle.fps, frames: segment.plan.idle.frames,
          conflict_policy: segment.plan.conflict_policy,
        })),
      });
      if (!session.batch_id) throw new Error("一括書き出しのセッションを開始できません");
      if (sessionId !== session.batch_id) {
        // Older mocked sessions return a server-generated ID.
        sessionId = session.batch_id;
        overlay.begin(sessionId, sequence.map((segment) => segment.kind === "speech"
           ? wavFilename(segment.plan.item.wavPath) : "待機 " + segment.plan.basename));
      }
      let successes = 0;
      let reusedCount = 0;
      let failures = 0;
      const complete: Array<
        { basename: string; frames: number; fps: number; samples: number; sample_rate: number }
        | { kind: "idle"; basename: string; frames: number; fps: number }> = [];
      const notes: string[] = [];
      const stagedResults: { id: string; result: MovieResult }[] = [];
      for (const [index, segment] of sequence.entries()) {
        const item = segment.plan.item;
        setProgress("MOVを書き出し中 " + (index + 1) + " / " + sequence.length +
          "：" + segment.plan.basename + ".mov");
        try {
          if (segment.kind === "idle") {
            const plan = segment.plan;
            const result = await post<{
              mov: string; frames: number; fps: number; audio: boolean; warning?: string;
            }>("preset-batch-idle-export", {
              ...idlePayload(draft, psdIdentity!, plan),
              batch_id: sessionId, batch_index: index,
            });
            if (result.mov !== plan.canonicalOutputDir + "/" + plan.basename + ".mov" ||
                result.frames !== plan.idle.frames ||
                result.fps !== plan.idle.fps || result.audio !== false) {
              throw new Error("無音待機MOVの検証結果が予定と一致しません");
            }
            complete.push({ kind: "idle", basename: plan.basename,
              frames: result.frames, fps: result.fps });
            if (result.warning) notes.push(result.warning);
            successes++;
          } else {
            const plan = segment.plan;
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
            if (result.reused) reusedCount++;
            successes++;
            stagedResults.push({ id: item.id, result });
          }
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
      setSummary("一括書き出し完了：MOV " + successes + "件（再利用 " +
        reusedCount + "件／新規・再生成 " + (successes - reusedCount) +
        "件）／全体OTIO " + done.otio +
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
        if (outcome === "success") {
          // The combined OTIO API already committed and released the lease.
          // A redundant cleanup request must never overwrite confirmed success.
          overlay.settle("success");
        } else try {
          const release = await post<{ released: boolean }>("preset-batch-cancel",
            { batch_id: sessionId });
          if (!release.released) {
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
