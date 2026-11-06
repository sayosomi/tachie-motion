import { useEffect, useRef, useState } from "react";
import type { Layer } from "./LayerTree";
import NativeFilePicker from "./NativeFilePicker";
import UtteranceList from "./UtteranceList";
import WavPlayback from "./WavPlayback";
import type { UnifiedPreset } from "./presetModel";
import { matchesSource, readPresetDraft, type PresetDraft } from "./presetDraftStorage";
import {
  createUtterance, moveUtterance, reorderUtterances, updateUtterance,
  type ExportData, type Fps, type LipMode, type UtteranceItem, type WavData,
} from "./utteranceItems";

type PsdData = { fingerprint: string; layers: Layer[] };
type Destination = {
  state: "available" | "complete" | "partial" | "unsafe" | "recovery_required";
  suggested_basename: string;
};
type DestinationCheck = { key: string; info: Destination };

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

export default function UtteranceWorkspace({ active = true }: { active?: boolean }) {
  const [draft, setDraft] = useState<PresetDraft | null>(null);
  const [items, setItems] = useState<UtteranceItem[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [pendingPath, setPendingPath] = useState("");
  const [defaultOutputDir, setDefaultOutputDir] = useState("");
  const [startupError, setStartupError] = useState("");
  const [addError, setAddError] = useState("");
  const [addingCount, setAddingCount] = useState(0);
  const [exportingId, setExportingId] = useState<string | null>(null);
  const [destination, setDestination] = useState<DestinationCheck | null>(null);
  const [destinationError, setDestinationError] = useState("");
  const [probeVersion, setProbeVersion] = useState(0);
  const sequence = useRef(0);
  const latestAdd = useRef(0);
  const selectionEpoch = useRef(0);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  // Keep the WAV list mounted across the Presets/Speech tabs. Refresh the
  // character snapshot when returning; reject changed PSDs, do not reuse a stale draft.
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setStartupError("");
    setDraft(null); // Block export until the returning preset snapshot is revalidated.
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
        setDefaultOutputDir(health.default_output_dir);
      } catch (err) {
        if (cancelled) return;
        setDraft(null);
        setStartupError(err instanceof Error ? err.message : String(err));
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [active]);

  const current = items.find((item) => item.id === activeId);
  const selected = draft?.collection.items.find((preset) => preset.id === current?.presetId);

  function selectItem(id: string) {
    selectionEpoch.current++;
    setActiveId(id);
  }

  function revise(id: string, patch: Partial<UtteranceItem>) {
    setItems((previous) => updateUtterance(previous, id, patch));
  }

  async function addWav(path: string): Promise<boolean> {
    if (!draft || !path.trim()) {
      setAddError("WAVのパスを指定してください");
      return false;
    }
    const request = ++latestAdd.current;
    const atEpoch = selectionEpoch.current;
    const ordinal = ++sequence.current;
    setAddingCount((count) => count + 1);
    try {
      const wav = await post<WavData>("wav", { path });
      if (!mounted.current) return false;
      const id = crypto.randomUUID();
      const presetId = draft.collection.defaultId ?? draft.collection.items[0].id;
      const item = createUtterance(id, path, wav, presetId, defaultOutputDir, ordinal);
      // Preserve the order of registration even when two analyses complete backwards.
      setItems((previous) => {
        const at = previous.findIndex((entry) => entry.registrationOrder > ordinal);
        return at < 0 ? [...previous, item] :
          [...previous.slice(0, at), item, ...previous.slice(at)];
      });
      if (request === latestAdd.current && selectionEpoch.current === atEpoch) {
        setActiveId(id);
      }
      setPendingPath((value) => value === path ? "" : value);
      return true;
    } catch (err) {
      if (mounted.current) {
        const reason = err instanceof Error ? err.message : String(err);
        // A newer WAV may have succeeded before this request failed.
        // Preserve every failure with its source path instead of dropping stale responses.
        setAddError((previous) => {
          const message = `${path}: ${reason}`;
          return previous ? `${previous} ／ ${message}` : message;
        });
      }
      return false;
    } finally {
      if (mounted.current) setAddingCount((count) => count - 1);
    }
  }

  async function addManyWavs(paths: string[]): Promise<boolean> {
    // Analyze in parallel while keeping registration order by the allocated sequence ID.
    // Partial failures remain visible with their original paths.
    const outcomes = await Promise.all(paths.map((path) => addWav(path)));
    return outcomes.some(Boolean);
  }

  function removeItem(id: string) {
    const index = items.findIndex((item) => item.id === id);
    if (index < 0 || exportingId === id) return;
    setItems((previous) => previous.filter((item) => item.id !== id));
    if (activeId === id) {
      selectionEpoch.current++;
      setActiveId(items[index + 1]?.id ?? items[index - 1]?.id ?? null);
    }
  }

  const destinationKey = current
    ? current.id + "\\0" + current.outputDir + "\\0" + current.basename : "";
  useEffect(() => {
    let cancelled = false;
    if (!current || !current.outputDir.trim() ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(current.basename)) {
      setDestination(null);
      setDestinationError("");
      return;
    }
    setDestination(null);
    setDestinationError("");
    void post<Destination>("preset-utterance-destination", {
      output_dir: current.outputDir, basename: current.basename,
    }).then((info) => {
      if (!cancelled) setDestination({ key: destinationKey, info });
    }).catch((err: unknown) => {
      if (!cancelled) setDestinationError(err instanceof Error ? err.message : String(err));
    });
    return () => { cancelled = true; };
  }, [destinationKey, probeVersion]);

  const info = destination?.key === destinationKey ? destination.info : undefined;
  const requiresAlternate = !!info && info.state !== "available" &&
    (info.state !== "complete" || current?.conflictChoice === "rename");
  const saveAsName = current?.saveAsName ?? info?.suggested_basename ?? "";
  const outputBasename = requiresAlternate ? saveAsName : current?.basename ?? "";
  const conflictPolicy = info?.state === "complete" && !requiresAlternate
    ? "overwrite" : "error";
  const allowed = !!selected && !selected.blinkEnabled &&
    (current?.mode === "none" || openMouthReady(selected));
  const canExport = !!draft && !!current && allowed && !exportingId &&
    !!info && !destinationError &&
    /^[A-Za-z0-9_-]{1,64}$/.test(outputBasename) &&
    (!requiresAlternate || outputBasename !== current.basename);

  async function exportUtterance() {
    if (!draft || !current || !selected || !canExport) return;
    const itemId = current.id;
    setExportingId(itemId);
    setItems((previous) => updateUtterance(previous, itemId, {}));
    try {
      const result = await post<ExportData>("preset-utterance-export", {
        psd: draft.path, wav: current.wavPath, fingerprint: draft.fingerprint,
        layers: selected.base, mouth: selected.openMouth ?? null,
        mode: current.mode, blink_enabled: selected.blinkEnabled,
        output_dir: current.outputDir, basename: outputBasename,
        conflict_policy: conflictPolicy, fps: current.fps,
      });
      if (mounted.current) setItems((previous) => previous.map((item) =>
        item.id === itemId ? { ...item, result, error: "" } : item));
    } catch (err) {
      if (mounted.current) setItems((previous) => previous.map((item) =>
        item.id === itemId ? { ...item, result: null,
          error: err instanceof Error ? err.message : String(err) } : item));
    } finally {
      if (mounted.current) {
        setExportingId(null);
        setProbeVersion((previous) => previous + 1);
      }
    }
  }

  return <main className="app utterance-workspace">
    <header className="topbar"><div className="brand"><span className="brand-mark">t</span>
      <span>tachie-motion</span></div></header>
    <div className="intro"><h1>セリフ</h1></div>
    <p className="hint utterance-scope">WAVを複数登録し、選択したセリフを個別に編集・書き出します。一括出力・aiueo・瞬き・待機・変更点は後続対応です。</p>
    {startupError && <p className="notice error" role="alert">{startupError}</p>}
    <UtteranceList items={items} selectedId={activeId} pendingPath={pendingPath}
      addingCount={addingCount} addError={addError}
      disabled={!draft} exportingId={exportingId}
      onPathChange={setPendingPath} onAdd={addWav} onAddMany={addManyWavs} onSelect={selectItem}
      onMove={(id, delta) => setItems((previous) => moveUtterance(previous, id, delta))}
      onReorder={(from, to, after) => setItems((previous) =>
        reorderUtterances(previous, from, to, after))}
      onRemove={removeItem} />
    <WavPlayback items={items} selectedId={activeId} />
    <div className="utterance-columns">
      <section className="panel">
        <h2>選択中のWAV</h2>
        <p className="hint">PSD: {draft?.path ?? "読み込み中…"}</p>
        {!current ? <p className="hint">一覧からセリフを選択してください。</p> : <>
          <p className="hint" title={current.wavPath}>WAV: {current.wavPath}</p>
          <p className="meta">長さ {current.wav.duration_seconds.toFixed(2)}秒 ／ {current.wav.sample_rate}Hz</p>
          <label htmlFor="speech-preset">プリセット</label>
          <select id="speech-preset" value={current.presetId}
            disabled={!draft || exportingId === current.id}
            onChange={(e) => revise(current.id, { presetId: e.target.value })}>
            {!selected && <option value={current.presetId}>（プリセットを再選択してください）</option>}
            {draft?.collection.items.map((preset) =>
              <option key={preset.id} value={preset.id}>{preset.name}</option>)}
          </select>
          <label htmlFor="speech-lip-mode">口パク方式</label>
          <select id="speech-lip-mode" value={current.mode}
            disabled={exportingId === current.id}
            onChange={(e) => revise(current.id, { mode: e.target.value as LipMode })}>
            <option value="none">なし</option>
            <option value="open">open（音量連動）</option>
            <option value="aiueo" disabled>aiueo（後続対応）</option>
          </select>
          {current.mode === "open" && !openMouthReady(selected) &&
            <p className="hint warning">このプリセットの「口パク（open）」で、異なる閉口・開口のレイヤー表示状態を設定してください。</p>}
          {selected?.blinkEnabled &&
            <p className="hint warning">このプリセットは瞬きが有効です。瞬きの書き出しは未実装です。</p>}
        </>}
      </section>
      <section className="panel">
        <h2>個別書き出し</h2>
        {!current ? <>
          <p className="hint">セリフを選択すると書き出し設定を編集できます。</p>
          <button type="button" className="primary" disabled>MOVとOTIOを書き出す</button>
        </> : <>
          <label htmlFor="speech-fps">フレームレート</label>
          <select id="speech-fps" value={current.fps}
            disabled={exportingId === current.id}
            onChange={(e) => revise(current.id, { fps: Number(e.target.value) as Fps })}>
            <option value={24}>24 fps</option><option value={30}>30 fps</option><option value={60}>60 fps</option>
          </select>
          <NativeFilePicker id="speech-output-dir" kind="output_dir" label="出力フォルダ"
            value={current.outputDir} disabled={exportingId === current.id}
            onChange={(path) => revise(current.id, { outputDir: path, saveAsName: null })}
            onSelected={(path) => revise(current.id, { outputDir: path, saveAsName: null })} />
          <label htmlFor="speech-basename">ファイル名（英数字・-・_）</label>
          <input id="speech-basename" value={current.basename}
            disabled={exportingId === current.id}
            onChange={(e) => revise(current.id, { basename: e.target.value, saveAsName: null })} />
          {destinationError && <p className="hint warning" role="alert">{destinationError}</p>}
          {info?.state === "complete" && <>
            <p className="hint">同名のMOV・OTIOがあります。</p>
            <fieldset className="output-conflict-choice">
              <legend>保存方法</legend>
              <label><input type="radio" name="speech-conflict" value="overwrite"
                checked={current.conflictChoice === "overwrite"}
                disabled={exportingId === current.id}
                onChange={() => revise(current.id, { conflictChoice: "overwrite" })} />上書きする</label>
              <label><input type="radio" name="speech-conflict" value="rename"
                checked={current.conflictChoice === "rename"}
                disabled={exportingId === current.id}
                onChange={() => revise(current.id, { conflictChoice: "rename" })} />別名で書き出す</label>
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
            <input id="speech-save-as" value={saveAsName}
              disabled={exportingId === current.id}
              onChange={(e) => revise(current.id, { saveAsName: e.target.value })} />
            <p className="hint">元のMOV・OTIOは残します。</p>
          </div>}
          {info && <p className="hint" aria-label="出力予定ファイル">
            出力予定：{outputBasename || "（未入力）"}.mov ／ {outputBasename || "（未入力）"}.otio
          </p>}
          <button type="button" className="primary" disabled={!canExport}
            onClick={() => { void exportUtterance(); }}>
            {exportingId === current.id ? "処理中…" : requiresAlternate ? "別名で書き出す"
              : info?.state === "complete" ? "上書きして書き出す" : "MOVとOTIOを書き出す"}
          </button>
          <p className="hint">選択中の1セリフのみ出力します。元PSD・WAVは変更しません。</p>
          {current.error && <p className="hint warning" role="alert">{current.error}</p>}
          {current.result && <div className="success" role="status">
            <strong>書き出し完了・{current.result.frames}フレーム</strong>
            <p>MOV: <code>{current.result.mov}</code></p>
            <p>OTIO: <code>{current.result.otio}</code></p>
            {current.result.warning && <p className="hint warning" role="alert">{current.result.warning}</p>}
          </div>}
        </>}
      </section>
    </div>
  </main>;
}
