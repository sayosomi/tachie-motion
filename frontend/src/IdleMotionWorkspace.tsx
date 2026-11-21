import { useEffect, useRef, useState } from "react";
import ExportProgressDialog from "./ExportProgressDialog";
import NativeFilePicker from "./NativeFilePicker";
import { blinkFrames } from "./blinkTiming";
import { idleExportPayload, idleReadinessError, parseIdleFrames, type IdleFps } from "./idleExportRequest";
import { validateOutputName } from "./nameTemplate";
import { matchesSource, readPresetDraft, type PresetDraft } from "./presetDraftStorage";
import { useExportProgress } from "./useExportProgress";
import type { Layer } from "./LayerTree";

type PsdSnapshot = { fingerprint: string; source_identity?: string; layers: Layer[] };
type Destination = {
  state: "available" | "complete" | "partial" | "unsafe" | "recovery_required";
  suggested_basename: string;
  folder_recovery_required?: boolean;
};
type CheckedDestination = { key: string; data: Destination };
type ExportResult = { mov: string; frames: number; warning?: string };

async function post<T>(route: string, body: object): Promise<T> {
  const response = await fetch("/api/" + route, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json() as T & { detail?: string };
  if (!response.ok) throw new Error(data.detail || "HTTP " + response.status);
  return data;
}

export default function IdleMotionWorkspace({ active, onBusyChange }: {
  active: boolean;
  onBusyChange: (busy: boolean) => void;
}) {
  const [draft, setDraft] = useState<PresetDraft | null>(null);
  const [sourceIdentity, setSourceIdentity] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [sourceError, setSourceError] = useState("");
  const [presetId, setPresetId] = useState("");
  const [frames, setFrames] = useState("150");
  const [fps, setFps] = useState<IdleFps>(30);
  const [outputDir, setOutputDir] = useState("");
  const [basename, setBasename] = useState("待機");
  // Consent is for one exact directory + basename, never a reusable UI toggle.
  const [overwriteTarget, setOverwriteTarget] = useState<string | null>(null);
  const [alternateName, setAlternateName] = useState("");
  const [primary, setPrimary] = useState<CheckedDestination | null>(null);
  const [alternate, setAlternate] = useState<CheckedDestination | null>(null);
  const [destinationError, setDestinationError] = useState("");
  const [result, setResult] = useState<ExportResult | null>(null);
  const [runError, setRunError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [running, setRunning] = useState(false);
  const busy = useRef(false);
  const uncertain = useRef(false);
  const progress = useExportProgress();
  const phase = progress.view?.phase;
  const progressActive = !!phase && !["success", "failed", "cancelled"].includes(phase);
  const locked = running || busy.current || progressActive;

  useEffect(() => {
    if (progressActive) onBusyChange(true);
    else if (!busy.current && !running) onBusyChange(false);
  }, [progressActive, running, onBusyChange]);

  // Keep the exact registered PSD snapshot fresh whenever this tab is entered.
  useEffect(() => {
    if (!active || locked) return;
    let cancelled = false;
    setLoading(true);
    setDraft(null);
    setSourceIdentity(null);
    setSourceError("");
    void (async () => {
      try {
        const saved = readPresetDraft();
        if (!saved || !saved.collection.items.length)
          throw new Error("先に「プリセット」でPSDとプリセットを設定してください。ページ内では元PSDを書き換えません。");
        const [snapshot, health] = await Promise.all([
          post<PsdSnapshot>("psd", { path: saved.path }),
          fetch("/api/health").then(async (response) => {
            if (!response.ok) throw new Error("出力フォルダの初期設定を取得できません");
            return response.json() as Promise<{ default_output_dir: string }>;
          }),
        ]);
        if (!snapshot.source_identity || !matchesSource(saved, snapshot.fingerprint, snapshot.layers))
          throw new Error("PSDまたはプリセットの登録状態が変わりました。「プリセット」で読み込み直してください。");
        if (cancelled) return;
        setDraft(saved);
        setSourceIdentity(snapshot.source_identity);
        setPresetId((old) => saved.collection.items.some((item) => item.id === old)
          ? old : saved.collection.defaultId ?? saved.collection.items[0].id);
        setOutputDir((old) => old || health.default_output_dir);
      } catch (error) {
        if (!cancelled) setSourceError(error instanceof Error ? error.message : String(error));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  // Also reload after recovering a progress token from a refreshed tab.
  }, [active, progressActive]);

  // A disconnected POST must not unlock the UI until an authoritative status arrives.
  useEffect(() => {
    if (!uncertain.current || (phase !== "success" && phase !== "failed" && phase !== "cancelled")) return;
    uncertain.current = false;
    busy.current = false;
    setRunning(false);
    setRefresh((value) => value + 1);
    onBusyChange(false);
    setRunError(phase === "success"
      ? "通信復旧後にサーバーの完了を確認しました。出力フォルダでMOVをご確認ください。"
      : "通信復旧後に処理の終了を確認しました。出力先と復旧情報をご確認ください。");
  }, [phase, onBusyChange]);

  const selected = draft?.collection.items.find((item) => item.id === presetId);
  const readiness = idleReadinessError(draft, selected, sourceIdentity, frames, fps);
  const count = parseIdleFrames(frames);
  let basenameError = "";
  try { validateOutputName(basename); }
  catch (error) { basenameError = error instanceof Error ? error.message : String(error); }

  const key = outputDir + "\0" + basename;
  const conflict = overwriteTarget === key ? "overwrite" : "rename";
  useEffect(() => {
    if (!active || !outputDir || basenameError || locked) {
      setPrimary(null); return;
    }
    let cancelled = false;
    setPrimary(null);
    setDestinationError("");
    void post<Destination>("preset-utterance-destination", {
      output_dir: outputDir, basename,
    }).then((data) => {
      if (!cancelled) setPrimary({ key, data });
    }).catch((error) => {
      if (!cancelled) setDestinationError(error instanceof Error ? error.message : String(error));
    });
    return () => { cancelled = true; };
  }, [active, key, refresh, locked]);

  const main = primary?.key === key ? primary.data : null;
  const needsAlternate = !!main && main.state !== "available" &&
    !(main.state === "complete" && conflict === "overwrite");
  const finalName = needsAlternate ? (alternateName || main?.suggested_basename || "") : basename;
  let finalNameValid = false;
  try { validateOutputName(finalName); finalNameValid = true; }
  catch { /* Leave text editable, disable export. */ }
  const alternateKey = outputDir + "\0" + finalName;
  useEffect(() => {
    if (!active || !needsAlternate || !finalNameValid || finalName === basename || locked) {
      setAlternate(null); return;
    }
    let cancelled = false;
    setAlternate(null);
    setDestinationError("");
    void post<Destination>("preset-utterance-destination", {
      output_dir: outputDir, basename: finalName,
    }).then((data) => {
      if (!cancelled) setAlternate({ key: alternateKey, data });
    }).catch((error) => {
      if (!cancelled) setDestinationError(error instanceof Error ? error.message : String(error));
    });
    return () => { cancelled = true; };
  }, [active, needsAlternate, alternateKey, finalNameValid, locked, refresh]);

  const alternateInfo = alternate?.key === alternateKey ? alternate.data : null;
  const destinationReady = !!main && !main.folder_recovery_required &&
    (main.state === "available" || (main.state === "complete" && conflict === "overwrite") ||
      (needsAlternate && finalName !== basename && alternateInfo?.state === "available" &&
        !alternateInfo.folder_recovery_required));
  const canRun = active && !loading && !locked && !readiness && !basenameError &&
    finalNameValid && !!outputDir && !destinationError && destinationReady;

  async function exportIdle() {
    if (!canRun || busy.current || !draft || !selected || !sourceIdentity || !count) return;
    busy.current = true;
    uncertain.current = false;
    onBusyChange(true);
    setRunning(true);
    setRunError("");
    setResult(null);
    const token = crypto.randomUUID();
    let submitted = false;
    try {
      // Fail before reserving if the PSD changed while the form was open.
      const psd = await post<PsdSnapshot>("psd", { path: draft.path });
      if (!psd.source_identity || psd.source_identity !== sourceIdentity ||
          !matchesSource(draft, psd.fingerprint, psd.layers) ||
          JSON.stringify(readPresetDraft()) !== JSON.stringify(draft)) {
        throw new Error("PSDまたはプリセットが変更されています。画面を開き直してください。");
      }
      await post("export-progress-reserve", { token, kind: "single", total: 1 });
      progress.begin(token, [finalName + ".mov"], "idle");
      submitted = true;
      const payload = idleExportPayload(draft, selected, sourceIdentity, count, fps,
        outputDir, finalName, needsAlternate ? "error" :
          main?.state === "complete" ? "overwrite" : "error", token);
      const output = await post<ExportResult>("idle-motion-export", payload);
      progress.settle("success");
      setResult(output);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (submitted && (error instanceof TypeError ||
          (error instanceof DOMException && error.name === "AbortError"))) {
        uncertain.current = true;
        progress.uncertain("通信が切れました。サーバー側の完了・復旧を確認するまで再書き出しはできません。");
      } else {
        if (submitted) progress.settle(reason.includes("書き出しをキャンセルしました")
          ? "cancelled" : "failed", reason);
        setRunError(reason);
      }
    } finally {
      if (!uncertain.current) {
        busy.current = false;
        onBusyChange(false);
        setRunning(false);
        setRefresh((value) => value + 1);
      }
    }
  }

  return <main className="app idle-workspace">
    <header className="topbar"><div className="brand"><span className="brand-mark">t</span>
      <span>tachie-motion</span></div></header>
    <div className="intro"><h1>場面専用の待機MOV</h1>
      <p>WAVなしで、選んだプリセットの立ち絵を指定尺の透過MOVに書き出します。</p></div>
    <p className="hint">ここでは1件のMOVを直接生成します。制作プロジェクトへの登録、編集点、ループ素材の管理は未対応です。</p>
    <p className="hint">PSD変更検出の起点はこの画面を開いて確認した時点です。プリセット保存後にPSDを再保存した場合は「プリセット」で読み込み直してください。</p>
    {sourceError && <p className="notice error" role="alert">{sourceError}</p>}
    {loading && <p className="hint" role="status">PSDと保存済みプリセットを確認中…</p>}
    <section className="panel idle-form" aria-label="待機MOVの設定">
      <h2>映像設定</h2>
      <label htmlFor="idle-preset">プリセット</label>
      <select id="idle-preset" value={presetId} disabled={locked || !draft || loading}
        onChange={(event) => { setPresetId(event.target.value); setResult(null); }}>
        {draft?.collection.items.map((preset) => <option key={preset.id} value={preset.id}>
          {preset.name}{preset.blinkEnabled ? "（瞬きON）" : ""}</option>)}
      </select>
      <div className="idle-duration-fields">
        <div><label htmlFor="idle-frames">フレーム数</label>
          <input id="idle-frames" inputMode="numeric" value={frames} disabled={locked}
            onChange={(event) => setFrames(event.target.value)} /></div>
        <div><label htmlFor="idle-fps">フレームレート</label>
          <select id="idle-fps" value={fps} disabled={locked}
            onChange={(event) => setFps(Number(event.target.value) as IdleFps)}>
            <option value={24}>24 fps</option><option value={30}>30 fps</option>
            <option value={60}>60 fps</option></select></div>
      </div>
      <p className="hint">{count ? `再生尺 ${Number((count / fps).toFixed(3))} 秒（${count} フレーム）` :
        "1～216000の整数フレームを指定してください。"}</p>
      <p className="hint">瞬き：{selected?.blinkEnabled ? "ON（プリセット設定に従う）" : "OFF"}。
        {selected?.blinkEnabled && blinkFrames(draft?.collection.blinkTiming, fps)
          ? " 共通の瞬き時間を使用します。" : ""} 口パク・音声は生成しません。</p>
      {readiness && <p className="hint warning" role="status">{readiness}</p>}
      <h2 className="idle-section-heading">出力先</h2>
      <NativeFilePicker id="idle-output-dir" kind="output_dir" label="MOVを保存するフォルダ"
        value={outputDir} disabled={locked}
        onChange={(value) => { setOutputDir(value); setAlternateName(""); setOverwriteTarget(null); }}
        onSelected={(value) => { setOutputDir(value); setAlternateName(""); setOverwriteTarget(null); }} />
      <label htmlFor="idle-basename">MOVファイル名（拡張子は自動で追加）</label>
      <input id="idle-basename" value={basename} disabled={locked}
        onChange={(event) => { setBasename(event.target.value); setAlternateName(""); setOverwriteTarget(null); }} />
      {basenameError && <p className="hint warning" role="alert">{basenameError}</p>}
      {main?.state === "complete" && <fieldset className="output-conflict-choice">
        <legend>同名のMOVが存在します</legend>
        <label><input type="radio" name="idle-conflict" checked={conflict === "rename"}
          disabled={locked} onChange={() => setOverwriteTarget(null)} />別名で保存</label>
        <label><input type="radio" name="idle-conflict" checked={conflict === "overwrite"}
          disabled={locked} onChange={() => setOverwriteTarget(key)} />明示的に上書き</label>
      </fieldset>}
      {needsAlternate && <>
        <p className="hint warning">{main?.state === "unsafe" ?
          "他のOTIOが参照している可能性があります。元MOVは保護されるため別名を指定してください。" :
          main?.state === "recovery_required" || main?.folder_recovery_required ?
            "復旧確認が必要です。復旧資料の確認または別のフォルダを選択してください。" :
            "元のMOVを残すため、別名で書き出します。"}</p>
        <label htmlFor="idle-alternate-name">別名MOVファイル名</label>
        <input id="idle-alternate-name" value={alternateName || main?.suggested_basename || ""}
          disabled={locked} onChange={(event) => setAlternateName(event.target.value)} />
        {alternateInfo && alternateInfo.state !== "available" &&
          <p className="hint warning" role="alert">この別名も使用できません。別の名前を入力してください。</p>}
      </>}
      {destinationError && <p className="hint warning" role="alert">{destinationError}</p>}
      <p className="hint" aria-label="待機MOVの出力予定">出力予定：{finalName || "（名前未設定）"}.mov
        ／ 音声なし ／ 個別OTIOなし</p>
      <button type="button" className="primary" disabled={!canRun}
        onClick={() => { void exportIdle(); }}>待機MOVを書き出す</button>
      {runError && <p className="hint warning" role="alert">{runError}</p>}
      {result && <div className="success" role="status">
        <strong>{result.frames}フレームのMOVを書き出しました</strong>
        <p>MOV: <code>{result.mov}</code></p>
        {result.warning && <p className="hint warning">{result.warning}</p>}
      </div>}
    </section>
    <ExportProgressDialog progress={progress.view}
      onCancel={() => { void progress.cancel(); }} onClose={progress.close} />
  </main>;
}
