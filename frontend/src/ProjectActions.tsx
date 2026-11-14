import { useRef, useState } from "react";
import type { Layer } from "./LayerTree";
import type { BatchNaming } from "./nameTemplate";
import NativeFilePicker from "./NativeFilePicker";
import { saveJsonFile } from "./browserJsonSave";
import {
  MAX_PROJECT_BYTES, parseProjectFile, serializeProjectFile, type ProjectFile,
} from "./projectFile";
import {
  inspectProjectSources, type ProjectInspection, type ProjectProblem,
} from "./projectRestore";
import type { PresetDraft } from "./presetDraftStorage";
import type { UtteranceItem } from "./utteranceItems";

type Stage = {
  file: ProjectFile;
  psdPath: string;
  wavPaths: Record<string, string>;
  approvedChanges: string[];
  problems: ProjectProblem[];
};
type Props = {
  draft: PresetDraft | null;
  layers: Layer[];
  items: UtteranceItem[];
  selectedId: string | null;
  naming: BatchNaming;
  disabled: boolean;
  onBusyChange: (busy: boolean) => void;
  onRestore: (project: ProjectFile, sources: ProjectInspection, psdPath: string,
    wavPaths: Record<string, string>) => void;
};

async function inspect<T>(kind: "psd" | "wav", path: string): Promise<T> {
  const response = await fetch("/api/" + kind, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
  const value = await response.json() as T & { detail?: string };
  if (!response.ok) throw new Error(value.detail || "HTTP " + response.status);
  return value;
}

export default function ProjectActions({
  draft, layers, items, selectedId, naming, disabled, onBusyChange, onRestore,
}: Props) {
  const input = useRef<HTMLInputElement>(null);
  const working = useRef(false);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<Stage | null>(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");

  function begin(): boolean {
    if (working.current || disabled) return false;
    working.current = true; // Synchronous lock, even before React's next paint.
    setBusy(true);
    onBusyChange(true);
    setError("");
    return true;
  }
  function finish() {
    working.current = false;
    setBusy(false);
    onBusyChange(false);
  }
  function reason(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  async function save() {
    if (!begin()) return;
    try {
      if (!draft) throw new Error("最初にPSDとプリセットを読み込んでください");
      // Serialize before invoking the native picker; then call it without
      // awaiting anything else so the browser still has user activation.
      const json = serializeProjectFile(draft, layers, items, selectedId, naming);
      const outcome = await saveJsonFile(
        json, "tachie-project", "tachie-project.json", "制作プロジェクトJSON");
      setStatus(outcome.status === "saved"
        ? "制作プロジェクトを保存しました：" + outcome.filename
        : "プロジェクトの保存をキャンセルしました。");
    } catch (failure) {
      setStatus("");
      setError("制作プロジェクトを保存できませんでした：" + reason(failure));
    } finally {
      finish();
    }
  }

  async function verifyAndRestore(candidate: Stage) {
    const checked = await inspectProjectSources(
      candidate.file, candidate.psdPath, candidate.wavPaths,
      new Set(candidate.approvedChanges), inspect);
    if (checked.problems.length) {
      setStage({ ...candidate, problems: checked.problems });
      setStatus("参照元を確認してください。編集内容はまだ変更していません。");
      return;
    }
    setStage({ ...candidate, problems: [] });
    if (!window.confirm("現在のプリセットとWAV一覧を制作プロジェクトの内容で置き換えますか？既存の編集状態は失われます。")) {
      setStatus("プロジェクトの読み込みをキャンセルしました。現在の編集内容は保持しています。");
      return;
    }
    // The parent writes the validated preset snapshot before updating either
    // component state. A storage error must propagate with no partial import.
    onRestore(candidate.file, checked, candidate.psdPath, candidate.wavPaths);
    setStage(null);
    setStatus("制作プロジェクトを読み込みました。WAVとプリセットを復元しました。");
  }

  async function importFile(file: File) {
    if (!begin()) return;
    setStatus("");
    try {
      if (file.size > MAX_PROJECT_BYTES) throw new Error("制作プロジェクトJSONが大きすぎます");
      const loaded = parseProjectFile(await file.text());
      const candidate: Stage = {
        file: loaded, psdPath: loaded.character.source.path,
        wavPaths: Object.fromEntries(loaded.items.map((item) => [item.id, item.wavPath])),
        approvedChanges: [], problems: [],
      };
      setStage(candidate);
      await verifyAndRestore(candidate);
    } catch (failure) {
      setError("制作プロジェクトを読み込めませんでした：" + reason(failure));
    } finally {
      finish();
    }
  }

  async function retry() {
    if (!stage || !begin()) return;
    setStatus("");
    try { await verifyAndRestore(stage); }
    catch (failure) {
      setError("制作プロジェクトを読み込めませんでした：" + reason(failure));
    } finally { finish(); }
  }

  function changePsd(path: string) {
    setStage((previous) => previous && { ...previous, psdPath: path });
  }
  function changeWav(id: string, path: string) {
    setStage((previous) => previous && {
      ...previous, wavPaths: { ...previous.wavPaths, [id]: path },
      approvedChanges: previous.approvedChanges.filter((entry) => entry !== id),
    });
  }

  return <div className="project-controls" aria-label="制作プロジェクト">
    <div className="project-file-actions">
      <span className="meta">制作プロジェクト</span>
      <button type="button" className="secondary" disabled={disabled || busy || !draft}
        onClick={() => { void save(); }}>JSONを保存</button>
      <button type="button" className="secondary" disabled={disabled || busy}
        onClick={() => input.current?.click()}>JSONを読み込む</button>
      <input type="file" id="project-file-input" ref={input} hidden
        accept=".json,application/json" disabled={disabled || busy}
        aria-label="制作プロジェクトJSONファイル"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file) void importFile(file);
        }} />
      {busy && <span className="hint" role="status">プロジェクトを確認中…</span>}
    </div>
    {status && !busy && <p className="hint" role="status">{status}</p>}
    {error && <p className="hint warning" role="alert">{error}</p>}
    {stage && !busy && <div className="project-repair" aria-label="プロジェクト参照の確認">
      <p className="hint">読み込み前の確認です。保存済みの参照が見つからない場合は再指定してください。確認・復元まで現在の編集は保持します。</p>
      {stage.problems.map((problem) => {
        const isPsd = problem.key === "psd";
        const item = isPsd ? undefined : stage.file.items.find((it) => it.id === problem.key);
        const currentPath = isPsd ? stage.psdPath :
          stage.wavPaths[problem.key] ?? item?.wavPath ?? problem.path;
        return <div className="project-repair-item" key={problem.key}>
          <p className="hint warning" role="alert">
            {isPsd ? "PSD" : "WAV：" + (item?.wavPath.split("/").at(-1) || item?.id || "")}
            {" — "}{problem.message}
          </p>
          <NativeFilePicker
            id={"project-repair-" + problem.key} kind={isPsd ? "psd" : "wav"}
            label={isPsd ? "PSDを再指定" : "WAVを再指定"}
            value={currentPath} disabled={busy || disabled}
            onChange={(path) => isPsd ? changePsd(path) : changeWav(problem.key, path)}
            onSelected={(path) => {
              if (isPsd) changePsd(path); else changeWav(problem.key, path);
              return true;
            }} />
          {!isPsd && currentPath === item?.wavPath &&
            problem.message.includes("保存時からWAVが変更") &&
            <label className="project-repair-approve">
              <input type="checkbox" disabled={busy || disabled}
                checked={stage.approvedChanges.includes(problem.key)}
                onChange={(event) => setStage((previous) => previous && ({
                  ...previous,
                  approvedChanges: event.target.checked
                    ? [...previous.approvedChanges, problem.key]
                    : previous.approvedChanges.filter((entry) => entry !== problem.key),
                }))} />
              変更されたWAVを、このセリフの音源として明示的に使用する
            </label>}
        </div>;
      })}
      <div className="project-file-actions">
        <button type="button" className="secondary" disabled={disabled}
          onClick={() => { void retry(); }}>再確認して読み込む</button>
        <button type="button" className="secondary" disabled={disabled}
          onClick={() => {
            setStage(null);
            setStatus("プロジェクトの読み込みをキャンセルしました。");
          }}>読み込みを取り消す</button>
      </div>
    </div>}
  </div>;
}
