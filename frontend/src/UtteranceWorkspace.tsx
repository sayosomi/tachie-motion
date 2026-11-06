import { useEffect, useState } from "react";
import type { Layer } from "./LayerTree";
import NativeFilePicker from "./NativeFilePicker";
import type { UnifiedPreset } from "./presetModel";
import { matchesSource, readPresetDraft, type PresetDraft } from "./presetDraftStorage";

type PsdData = { fingerprint: string; layers: Layer[] };
type WavData = { samples: number; sample_rate: number; duration_seconds: number };
type ExportData = { mov: string; otio: string; frames: number; sample_count: number; warning?: string };
type Destination = {
  state: "available" | "complete" | "partial" | "unsafe" | "recovery_required";
  suggested_basename: string;
};
type DestinationCheck = { key: string; info: Destination };
type LipMode = "none" | "open";

async function post<T>(route: string, payload: object): Promise<T> {
  const res = await fetch("/api/" + route, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json() as T & { detail?: string };
  if (!res.ok) throw new Error(data.detail || "HTTP " + res.status);
  return data;
}

function openMouthReady(preset?: UnifiedPreset): boolean {
  const mouth = preset?.openMouth;
  return Boolean(mouth && mouth.closed.length > 0 &&
    mouth.closed.length === mouth.opened.length &&
    JSON.stringify(mouth.closed) !== JSON.stringify(mouth.opened));
}

export default function UtteranceWorkspace() {
  const [draft, setDraft] = useState<PresetDraft | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [wavPath, setWavPath] = useState("");
  const [wav, setWav] = useState<WavData | null>(null);
  const [mode, setMode] = useState<LipMode>("none");
  const [fps, setFps] = useState<24 | 30 | 60>(30);
  const [outputDir, setOutputDir] = useState("");
  const [basename, setBasename] = useState("speech_001");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ExportData | null>(null);
  const [destination, setDestination] = useState<DestinationCheck | null>(null);
  const [destinationError, setDestinationError] = useState("");
  const [conflictChoice, setConflictChoice] = useState<"overwrite" | "rename">("overwrite");
  const [saveAsName, setSaveAsName] = useState("");
  const [probeVersion, setProbeVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const saved = readPresetDraft();
        if (!saved || saved.collection.items.length === 0) {
          throw new Error("最初に「プリセット」でPSDとプリセットを設定してください");
        }
        const [psd, health] = await Promise.all([
          post<PsdData>("psd", { path: saved.path }),
          fetch("/api/health").then(async (response) => {
            if (!response.ok) throw new Error("出力設定を取得できません");
            return response.json() as Promise<{ default_output_dir: string }>;
          }),
        ]);
        if (!matchesSource(saved, psd.fingerprint, psd.layers)) {
          throw new Error("PSDが変更されています。「プリセット」で読み込み直してください");
        }
        if (cancelled) return;
        setDraft(saved);
        setSelectedId(saved.collection.defaultId ?? saved.collection.items[0].id);
        setOutputDir(health.default_output_dir);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    };
    void load();
    return () => { cancelled = true; };
  }, []);

  const destinationKey = outputDir + "\\0" + basename;
  useEffect(() => {
    let cancelled = false;
    if (!outputDir.trim() || !/^[A-Za-z0-9_-]{1,64}$/.test(basename)) {
      setDestination(null);
      setDestinationError("");
      return;
    }
    setDestination(null);
    setDestinationError("");
    void post<Destination>("preset-utterance-destination", {
      output_dir: outputDir, basename,
    }).then((info) => {
      if (cancelled) return;
      setDestination({ key: destinationKey, info });
      setSaveAsName(info.suggested_basename);
    }).catch((error: unknown) => {
      if (cancelled) return;
      setDestinationError(error instanceof Error ? error.message : String(error));
    });
    return () => { cancelled = true; };
  }, [outputDir, basename, destinationKey, probeVersion]);

  const selected = draft?.collection.items.find((p) => p.id === selectedId);
  const allowed = !!selected && !selected.blinkEnabled &&
    (mode === "none" || openMouthReady(selected));
  const info = destination?.key === destinationKey ? destination.info : undefined;
  const requiresAlternate = !!info && info.state !== "available" &&
    (info.state !== "complete" || conflictChoice === "rename");
  const outputBasename = requiresAlternate ? saveAsName : basename;
  const conflictPolicy = info?.state === "complete" && !requiresAlternate
    ? "overwrite" : "error";
  const validOutputName = /^[A-Za-z0-9_-]{1,64}$/.test(outputBasename);
  const canExport = !!draft && allowed && !!wav && !busy &&
    !!info && !destinationError && validOutputName &&
    (!requiresAlternate || outputBasename !== basename);

  async function inspectWav(path = wavPath) {
    setBusy(true); setError(""); setWav(null); setResult(null);
    try { setWav(await post<WavData>("wav", { path })); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  }

  async function exportUtterance() {
    if (!draft || !selected || !canExport) return;
    setBusy(true); setError(""); setResult(null);
    try {
      setResult(await post<ExportData>("preset-utterance-export", {
        psd: draft.path, wav: wavPath, fingerprint: draft.fingerprint,
        layers: selected.base, mouth: selected.openMouth ?? null,
        mode, blink_enabled: selected.blinkEnabled,
        output_dir: outputDir, basename: outputBasename,
        conflict_policy: conflictPolicy, fps,
      }));
      setProbeVersion((previous) => previous + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setProbeVersion((previous) => previous + 1);
    }
    finally { setBusy(false); }
  }

  return <main className="app utterance-workspace">
    <header className="topbar"><div className="brand"><span className="brand-mark">t</span>
      <span>tachie-motion</span></div></header>
    <div className="intro"><h1>セリフ</h1></div>
    <p className="hint utterance-scope">プリセットを使った1セリフの書き出しです。複数セリフ・aiueo・瞬き・待機・変更点は後続対応です。</p>
    {error && <p className="notice error" role="alert">{error}</p>}
    <div className="utterance-columns">
      <section className="panel">
        <h2>素材とプリセット</h2>
        <p className="hint">PSD: {draft?.path ?? "読み込み中…"}</p>
        <NativeFilePicker id="speech-wav-path" kind="wav" label="WAVファイル"
          value={wavPath} disabled={busy}
          onChange={(path) => { setWavPath(path); setWav(null); setResult(null); }}
          onSelected={(path) => { setWavPath(path); setWav(null); setResult(null); return inspectWav(path); }}
          onApply={() => inspectWav()} applyLabel="WAVを確認" />
        {wav && <p className="meta">長さ {wav.duration_seconds.toFixed(2)}秒 ／ {wav.sample_rate}Hz</p>}
        <label htmlFor="speech-preset">プリセット</label>
        <select id="speech-preset" value={selectedId} disabled={!draft || busy}
          onChange={(e) => { setSelectedId(e.target.value); setResult(null); }}>
          {draft?.collection.items.map((preset) =>
            <option key={preset.id} value={preset.id}>{preset.name}</option>)}
        </select>
        <label htmlFor="speech-lip-mode">口パク方式</label>
        <select id="speech-lip-mode" value={mode} disabled={busy}
          onChange={(e) => { setMode(e.target.value as LipMode); setResult(null); }}>
          <option value="none">なし</option>
          <option value="open">open（音量連動）</option>
          <option value="aiueo" disabled>aiueo（後続対応）</option>
        </select>
        {mode === "open" && !openMouthReady(selected) &&
          <p className="hint warning">このプリセットの「口パク（open）」で、異なる閉口・開口のレイヤー表示状態を設定してください。</p>}
        {selected?.blinkEnabled &&
          <p className="hint warning">このプリセットは瞬きが有効です。瞬きの書き出しは未実装のため出力を停止しています。</p>}
      </section>
      <section className="panel">
        <h2>書き出し</h2>
        <label htmlFor="speech-fps">フレームレート</label>
        <select id="speech-fps" value={fps} disabled={busy}
          onChange={(e) => { setFps(Number(e.target.value) as 24 | 30 | 60); setResult(null); }}>
          <option value={24}>24 fps</option><option value={30}>30 fps</option><option value={60}>60 fps</option>
        </select>
        <NativeFilePicker id="speech-output-dir" kind="output_dir" label="出力フォルダ"
          value={outputDir} disabled={busy}
          onChange={(path) => { setOutputDir(path); setResult(null); }}
          onSelected={(path) => { setOutputDir(path); setResult(null); }} />
        <label htmlFor="speech-basename">ファイル名（英数字・-・_）</label>
        <input id="speech-basename" value={basename} disabled={busy}
          onChange={(e) => { setBasename(e.target.value); setResult(null); }} />
        {destinationError && <p className="hint warning" role="alert">{destinationError}</p>}
        {info?.state === "complete" && <>
          <p className="hint">同名のMOV・OTIOがあります。</p>
          <fieldset className="output-conflict-choice">
            <legend>保存方法</legend>
            <label><input type="radio" name="speech-conflict" value="overwrite"
              checked={conflictChoice === "overwrite"} disabled={busy}
              onChange={() => setConflictChoice("overwrite")} />上書きする</label>
            <label><input type="radio" name="speech-conflict" value="rename"
              checked={conflictChoice === "rename"} disabled={busy}
              onChange={() => setConflictChoice("rename")} />別名で書き出す</label>
          </fieldset>
        </>}
        {info && info.state !== "available" && info.state !== "complete" &&
          <p className="hint warning" role="status">
            {info.state === "partial"
              ? "同名のMOV・OTIOの片方だけがあります。安全のため上書きできません。"
              : info.state === "unsafe"
                ? "同名の出力先が通常ファイルではありません。上書きできません。"
                : "前回の書き出しで復旧確認が必要なファイルが残っています。同名への書き出しは停止します。"}
          </p>}
        {requiresAlternate && <div className="output-save-as">
          <label htmlFor="speech-save-as">別名のファイル名</label>
          <input id="speech-save-as" value={saveAsName} disabled={busy}
            onChange={(event) => { setSaveAsName(event.target.value); setResult(null); }} />
          <p className="hint">元のMOV・OTIOは残します。</p>
        </div>}
        {info && <p className="hint" aria-label="出力予定ファイル">
          出力予定：{outputBasename || "（未入力）"}.mov ／ {outputBasename || "（未入力）"}.otio
        </p>}
        <button type="button" className="primary" disabled={!canExport}
          onClick={() => { void exportUtterance(); }}>
          {busy ? "処理中…" : requiresAlternate ? "別名で書き出す"
            : info?.state === "complete" ? "上書きして書き出す" : "MOVとOTIOを書き出す"}
        </button>
        <p className="hint">選択中プリセットの表示状態を使用します。元PSD・WAVは変更しません。上書き時は検証後に出力ファイルを更新し、通常の失敗では元の組を復旧します。強制終了時は復旧用バックアップを保持します。</p>
        {result && <div className="success" role="status">
          <strong>書き出し完了・{result.frames}フレーム</strong>
          <p>MOV: <code>{result.mov}</code></p>
          <p>OTIO: <code>{result.otio}</code></p>
          {result.warning && <p className="hint warning" role="alert">{result.warning}</p>}
        </div>}
      </section>
    </div>
  </main>;
}
