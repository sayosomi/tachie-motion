import NativeFilePicker from "./NativeFilePicker";
import type { UnifiedPreset } from "./presetModel";
import type { Fps, UtteranceItem } from "./utteranceItems";

export type ExportScope = "single" | "all";
export type ExportDestination = {
  state: "available" | "complete" | "partial" | "unsafe" | "recovery_required";
  suggested_basename: string;
};
export type BatchStatus = {
  running: boolean;
  progress: string;
  summary: string;
  run: () => Promise<void>;
};
type Props = {
  items: UtteranceItem[];
  current: UtteranceItem | undefined;
  selected: UnifiedPreset | undefined;
  draftAvailable: boolean;
  info: ExportDestination | undefined;
  destinationError: string;
  requiresAlternate: boolean;
  saveAsName: string;
  outputBasename: string;
  canExport: boolean;
  exportingId: string | null;
  addingCount: number;
  scope: ExportScope;
  onScopeChange: (scope: ExportScope) => void;
  onRevise: (id: string, patch: Partial<UtteranceItem>) => void;
  onSingleExport: () => void;
  batch: BatchStatus;
};

export default function UtteranceExportPanel({
  items, current, selected, draftAvailable, info, destinationError, requiresAlternate,
  saveAsName, outputBasename, canExport, exportingId, addingCount,
  scope, onScopeChange, onRevise, onSingleExport, batch,
}: Props) {
  const locked = batch.running || !!exportingId;
  const noneCount = items.filter((item) => item.mode === "none").length;
  const canSubmit = scope === "single" ? canExport :
    draftAvailable && items.length > 0 && !locked && addingCount === 0;

  return <section className="panel utterance-export-panel" aria-label="書き出し">
    <h2>書き出し</h2>
    <fieldset className="export-scope" aria-label="書き出し対象">
      <legend>対象</legend>
      <label><input type="radio" name="speech-export-scope" value="single"
        checked={scope === "single"} disabled={locked}
        onChange={() => onScopeChange("single")} />選択中の1件</label>
      <label><input type="radio" name="speech-export-scope" value="all"
        checked={scope === "all"} disabled={locked}
        onChange={() => onScopeChange("all")} />全件（{items.length}件）</label>
    </fieldset>

    {current ? <div className="export-current-settings">
      <p className="hint">選択中のセリフの保存設定です。全件を選んでも、各WAVに指定した設定を使用します。</p>
      <label htmlFor="speech-fps">フレームレート</label>
      <select id="speech-fps" value={current.fps}
        disabled={locked}
        onChange={(e) => onRevise(current.id, { fps: Number(e.target.value) as Fps })}>
        <option value={24}>24 fps</option><option value={30}>30 fps</option><option value={60}>60 fps</option>
      </select>
      <NativeFilePicker id="speech-output-dir" kind="output_dir" label="出力フォルダ"
        value={current.outputDir} disabled={locked}
        onChange={(path) => onRevise(current.id, { outputDir: path, saveAsName: null })}
        onSelected={(path) => onRevise(current.id, { outputDir: path, saveAsName: null })} />
      <label htmlFor="speech-basename">ファイル名（英数字・-・_）</label>
      <input id="speech-basename" value={current.basename}
        disabled={locked}
        onChange={(e) => onRevise(current.id, { basename: e.target.value, saveAsName: null })} />
      {destinationError && <p className="hint warning" role="alert">{destinationError}</p>}
      {info?.state === "complete" && <>
        <p className="hint">同名のMOV・OTIOがあります。</p>
        <fieldset className="output-conflict-choice">
          <legend>保存方法</legend>
          <label><input type="radio" name="speech-conflict" value="overwrite"
            checked={current.conflictChoice === "overwrite"} disabled={locked}
            onChange={() => onRevise(current.id, { conflictChoice: "overwrite" })} />上書きする</label>
          <label><input type="radio" name="speech-conflict" value="rename"
            checked={current.conflictChoice === "rename"} disabled={locked}
            onChange={() => onRevise(current.id, { conflictChoice: "rename" })} />別名で書き出す</label>
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
        <input id="speech-save-as" value={saveAsName} disabled={locked}
          onChange={(e) => onRevise(current.id, { saveAsName: e.target.value })} />
        <p className="hint">元のMOV・OTIOは残します。</p>
      </div>}
      {info && <p className="hint" aria-label="出力予定ファイル">
        出力予定：{outputBasename || "（未入力）"}.mov ／ {outputBasename || "（未入力）"}.otio
      </p>}
    </div> : <p className="hint">WAVを選択すると保存先・ファイル名を編集できます。</p>}

    {scope === "all" && <div className="export-overview">
      <h3>全件の書き出し内容</h3>
      <p className="hint">一覧順に各WAVのMOV（音声入り）と個別OTIOを生成します。</p>
      {noneCount > 0 && <p className="hint warning" role="note">
        口パク「なし」が{noneCount}件あります。口を動かす場合は各WAVの方式をopenにしてください。
      </p>}
      <ol className="export-plan-items">
        {items.map((item) => <li key={item.id}>
          <span className="export-plan-name" title={item.wavPath}>{item.wavPath.split(/[\\/]/).at(-1)}</span>
          <span>{item.mode === "open" ? "口パク: open" : "口パク: なし"}</span>
          <span title={item.outputDir}>{item.basename}.mov ＋ .otio</span>
          <span>{item.error ? "失敗" : item.result ? "完了" : "未出力"}</span>
        </li>)}
      </ol>
    </div>}
    <div className="export-execution">
      <button type="button" className="primary" disabled={!canSubmit}
        onClick={() => { if (scope === "all") void batch.run(); else onSingleExport(); }}>
        {batch.running ? "書き出し中…" :
          scope === "all" ? "全件を書き出す" :
          exportingId === current?.id ? "処理中…" :
          requiresAlternate ? "別名で書き出す" :
          info?.state === "complete" ? "上書きして書き出す" : "MOVとOTIOを書き出す"}
      </button>
      <p className="hint">{scope === "all"
        ? "同じ出力先への重複は開始前に検出します。上書きは確認し、部分失敗も一覧に表示します。"
        : "選択中の1セリフのみ出力します。元PSD・WAVは変更しません。"}</p>
      {batch.progress && <p className="hint" role="status">{batch.progress}</p>}
      {batch.summary && <p className="hint" role="status">{batch.summary}</p>}
      {current?.error && <p className="hint warning" role="alert">{current.error}</p>}
      {current?.result && <div className="success" role="status">
        <strong>書き出し完了・{current.result.frames}フレーム</strong>
        <p>MOV: <code>{current.result.mov}</code></p>
        <p>OTIO: <code>{current.result.otio}</code></p>
        {current.result.warning && <p className="hint warning" role="alert">{current.result.warning}</p>}
      </div>}
    </div>
  </section>;
}
