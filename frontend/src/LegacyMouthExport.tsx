import { useEffect, useState } from "react";
import LayerTree, { type BindingKind, type Layer } from "./LayerTree";
type PsdData = { width: number; height: number; layers: Layer[]; preview: string };
type WavData = { samples: number; sample_rate: number; duration_seconds: number };
type ExportData = { mov: string; otio: string; frames: number; sample_count: number };

async function request<T>(endpoint: string, body: object): Promise<T> {
  const response = await fetch("/api/" + endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data: { detail?: string } = await response.json();
  if (!response.ok) {
    throw new Error(data.detail || "HTTP " + response.status);
  }
  return data as T;
}

export default function LegacyMouthExport() {
  const [psdPath, setPsdPath] = useState("");
  const [wavPath, setWavPath] = useState("");
  const [outputDir, setOutputDir] = useState("");
  const [basename, setBasename] = useState("tachie-mouth");
  const [fps, setFps] = useState<24 | 30 | 60>(30);
  const [psd, setPsd] = useState<PsdData | null>(null);
  const [wav, setWav] = useState<WavData | null>(null);
  const [closed, setClosed] = useState("");
  const [opened, setOpened] = useState("");
  const [eyeOpen, setEyeOpen] = useState("");
  const [eyeClosed, setEyeClosed] = useState("");
  const [preview, setPreview] = useState("");
  const [previewLabel, setPreviewLabel] = useState("PSDの現在表示");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [result, setResult] = useState<ExportData | null>(null);

  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json())
      .then((info: { default_output_dir: string }) => setOutputDir(info.default_output_dir))
      .catch(() => setError("ローカルAPIに接続できません。tachie-webを起動してください。"));
  }, []);

  async function perform(label: string, action: () => Promise<void>) {
    setBusy(label);
    setError("");
    try { await action(); }
    catch (ex) { setError(ex instanceof Error ? ex.message : String(ex)); }
    finally { setBusy(""); }
  }

  function changePsd(path: string) {
    setPsdPath(path);
    setPsd(null); setClosed(""); setOpened(""); setEyeOpen(""); setEyeClosed(""); setPreview("");
    setPreviewLabel("PSD未読込"); setResult(null);
  }

  function changeWav(path: string) {
    setWavPath(path); setWav(null); setResult(null);
  }

  function changeBinding(kind: BindingKind, path: string) {
    // Selecting the same path again clears this one assignment.
    // An explicit "解除" control in the selection summary uses the same behavior.
    if (kind === "closed") setClosed((current) => current === path ? "" : path);
    else if (kind === "opened") setOpened((current) => current === path ? "" : path);
    else if (kind === "eyeOpen") setEyeOpen((current) => current === path ? "" : path);
    else setEyeClosed((current) => current === path ? "" : path);
    // A previous image no longer represents the selected binding.
    setPreview("");
    setPreviewLabel("プレビュー未更新");
    setResult(null);
  }

  const bindingsReady = Boolean(psd && closed && opened && closed !== opened);
  const eyesReady = Boolean(psd && eyeOpen && eyeClosed && eyeOpen !== eyeClosed);
  const canExport = bindingsReady && Boolean(wav) &&
    Boolean(outputDir.trim()) && Boolean(basename.trim()) && !busy;

  async function inspectPsd() {
    await perform("PSDを読み込み中", async () => {
      const data = await request<PsdData>("psd", { path: psdPath });
      setPsd(data); setPreview(data.preview); setPreviewLabel("PSDの現在表示");
      setClosed(""); setOpened(""); setEyeOpen(""); setEyeClosed(""); setResult(null);
    });
  }

  async function inspectWav() {
    await perform("WAVを確認中", async () => {
      const data = await request<WavData>("wav", { path: wavPath });
      setWav(data); setResult(null);
    });
  }

  async function showVariant(target: "mouth" | "eyes", state: "closed" | "open") {
    await perform("プレビューを作成中", async () => {
      const data = await request<{ preview: string }>("preview", {
        path: psdPath,
        closed: target === "mouth" ? closed : eyeClosed,
        opened: target === "mouth" ? opened : eyeOpen,
        state,
      });
      setPreview(data.preview);
      setPreviewLabel(target === "mouth"
        ? (state === "closed" ? "閉じた口" : "開いた口")
        : (state === "closed" ? "閉じた目" : "開いた目"));
    });
  }

  async function exportMedia() {
    await perform("MOVとOTIOを書き出し中", async () => {
      setResult(null);
      const data = await request<ExportData>("export", {
        psd: psdPath, wav: wavPath, closed, opened,
        output_dir: outputDir, basename, fps,
      });
      setResult(data);
    });
  }

  return (
    <main className="app">
      <header className="topbar">
        <div className="brand"><span className="brand-mark">t</span>
          <span>tachie-motion <small>LOCAL WEB / PHASE 1</small></span>
        </div>
        <span className="local-indicator">● 127.0.0.1 ONLY</span>
      </header>
      <div className="intro">
        <p className="eyebrow">CHARACTER ANIMATION / MOUTH EXPORT</p>
        <h1>立ち絵を、声に合わせて動かす。</h1>
        <p>PSDとWAVを指定し、口レイヤーを選択して透過MOVとOTIOを書き出します。</p>
      </div>
      {error && <div role="alert" className="notice error">{error}</div>}
      {busy && <div role="status" className="notice processing">{busy}。操作が完了するまでお待ちください。</div>}

      <div className="workspace">
        <section className="panel setup">
          <div className="panel-heading"><span className="section-num">01</span><h2>素材を読み込む</h2></div>
          <label htmlFor="psd-path">PSDファイルの絶対パス</label>
          <div className="input-row">
            <input id="psd-path" value={psdPath} disabled={Boolean(busy)}
              onChange={(e) => changePsd(e.target.value)} placeholder="/Volumes/.../character.psd" />
            <button disabled={!psdPath.trim() || Boolean(busy)} onClick={inspectPsd}>PSDを読み込む</button>
          </div>
          {psd && <div className="meta">キャンバス {psd.width} × {psd.height} px ・ レイヤー {psd.layers.length}件</div>}

          <div className="panel-heading layer-heading"><span className="section-num">02</span><h2>口・目のレイヤーを指定</h2></div>
          <p className="hint">PSDの元の階層を開閉し、口・目の各状態を手動で選びます。名前からの自動判定はしません。</p>
          {psd ? <LayerTree layers={psd.layers} key={psdPath}
            bindings={{ closed, opened, eyeOpen, eyeClosed }}
            disabled={Boolean(busy)} onChoose={changeBinding} />
            : <div className="empty-state">PSDを読み込むとレイヤーツリーが表示されます。</div>}
          <div className="bindings">
            <span>閉じた口 <b>{closed || "未選択"}</b>
              {closed && <button type="button" className="secondary clear-binding"
                disabled={Boolean(busy)} aria-label="閉じた口の指定を解除"
                onClick={() => changeBinding("closed", closed)}>解除</button>}</span>
            <span>開いた口 <b>{opened || "未選択"}</b>
              {opened && <button type="button" className="secondary clear-binding"
                disabled={Boolean(busy)} aria-label="開いた口の指定を解除"
                onClick={() => changeBinding("opened", opened)}>解除</button>}</span>
            <span>開いた目 <b>{eyeOpen || "未選択"}</b>
              {eyeOpen && <button type="button" className="secondary clear-binding"
                disabled={Boolean(busy)} aria-label="開いた目の指定を解除"
                onClick={() => changeBinding("eyeOpen", eyeOpen)}>解除</button>}</span>
            <span>閉じた目 <b>{eyeClosed || "未選択"}</b>
              {eyeClosed && <button type="button" className="secondary clear-binding"
                disabled={Boolean(busy)} aria-label="閉じた目の指定を解除"
                onClick={() => changeBinding("eyeClosed", eyeClosed)}>解除</button>}</span>
          </div>
          {closed && closed === opened && <p className="hint warning">閉じた口と開いた口には異なるレイヤーを指定してください。</p>}
          {eyeOpen && eyeOpen === eyeClosed && <p className="hint warning">開いた目と閉じた目には異なるレイヤーを指定してください。</p>}
          <p className="hint">目レイヤーは選択・静止画プレビューのみ対応しています。瞬きをMOVに反映する機能は後続開発です。</p>
          <div className="panel-heading layer-heading"><span className="section-num">03</span><h2>音声を読み込む</h2></div>
          <label htmlFor="wav-path">WAVファイルの絶対パス</label>
          <div className="input-row">
            <input id="wav-path" value={wavPath} disabled={Boolean(busy)}
              onChange={(e) => changeWav(e.target.value)} placeholder="/Volumes/.../speech.wav" />
            <button disabled={!wavPath.trim() || Boolean(busy)} onClick={inspectWav}>WAVを確認</button>
          </div>
          {wav && <div className="meta">音声 {wav.duration_seconds.toFixed(3)}秒 ・ {wav.sample_rate} Hz ・ {wav.samples} samples</div>}
          <p className="hint">MacではFinderでファイルを選び、⌥⌘Cでパスをコピーできます。元ファイルは変更・複製しません。</p>

        </section>

        <div className="right-side">
          <section className="panel preview-panel">
            <div className="panel-heading"><span className="section-num">04</span><h2>プレビュー</h2></div>
            <div className="preview-stage">
              {preview ? <img alt={previewLabel} src={preview} /> :
                <div className="preview-empty">{psd ? "口・目の選択を変更しました。状態を再プレビューしてください。" : "PSDを読み込んでプレビューを表示"}</div>}
            </div>
            <div className="preview-footer">
              <span className="meta">{previewLabel}</span>
              <div className="preview-buttons">
                <button className="secondary" disabled={!bindingsReady || Boolean(busy)}
                  onClick={() => showVariant("mouth", "closed")}>閉じた口</button>
                <button className="secondary" disabled={!bindingsReady || Boolean(busy)}
                  onClick={() => showVariant("mouth", "open")}>開いた口</button>
                <button className="secondary" disabled={!eyesReady || Boolean(busy)}
                  onClick={() => showVariant("eyes", "open")}>開いた目</button>
                <button className="secondary" disabled={!eyesReady || Boolean(busy)}
                  onClick={() => showVariant("eyes", "closed")}>閉じた目</button>
              </div>
            </div>
          </section>

          <section className="panel export-panel">
            <div className="panel-heading"><span className="section-num">05</span><h2>書き出し</h2></div>
            <div className="export-grid">
              <div><label htmlFor="fps">フレームレート</label>
                <select id="fps" value={fps} disabled={Boolean(busy)}
                  onChange={(e) => { setFps(Number(e.target.value) as 24 | 30 | 60); setResult(null); }}>
                  <option value={24}>24 fps</option><option value={30}>30 fps</option><option value={60}>60 fps</option>
                </select>
              </div>
              <div><label htmlFor="basename">出力ファイル名（拡張子なし）</label>
                <input id="basename" value={basename} disabled={Boolean(busy)}
                  onChange={(e) => { setBasename(e.target.value); setResult(null); }} /></div>
            </div>
            <label htmlFor="outdir">出力フォルダ（既存の絶対パス）</label>
            <input id="outdir" value={outputDir} disabled={Boolean(busy)}
              onChange={(e) => { setOutputDir(e.target.value); setResult(null); }} />
            <button className="primary" disabled={!canExport} onClick={exportMedia}>
              {busy === "MOVとOTIOを書き出し中" ? "書き出し処理中…" : "MOV + OTIOを書き出す"}
            </button>
            <p className="hint">現在のMOV・OTIOは口パクのみです。選択した目の瞬きは含まれません。既存ファイルは上書きしません。WAVは原本を参照し、コピーしません。ProRes全フレームを検証します。</p>
            {result && <div className="success" role="status">
              <strong>書き出し完了 ・ {result.frames}フレーム</strong>
              <p>MOV: <code>{result.mov}</code></p>
              <p>OTIO: <code>{result.otio}</code></p>
              <p>WAV: 元ファイルを参照（コピーなし）</p>
            </div>}
          </section>
        </div>
      </div>
      <footer>LOCAL ONLY · NO MEDIA UPLOAD · NO WAV DUPLICATION · EARLY SINGLE-CHARACTER UI</footer>
    </main>
  );
}
