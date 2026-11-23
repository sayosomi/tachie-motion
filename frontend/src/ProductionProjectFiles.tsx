import { useRef, useState } from "react";
import NativeFilePicker from "./NativeFilePicker";
import { saveJsonFile } from "./browserJsonSave";
import {
  MAX_NEXT_PROJECT_BYTES, parseNextProjectFile, serializeNextProjectFile,
  type NextProjectFile,
} from "./multiProjectFile";
import { applyProductionInspection } from "./multiProjectEditing";
import {
  inspectNextProjectSources, type NextProjectInspection,
} from "./multiProjectRestore";
import type { ProjectProblem } from "./projectRestore";

type Staged = {
  file: NextProjectFile;
  psdPaths: Record<string, string>;
  wavPaths: Record<string, string>;
  approved: string[];
  problems: ProjectProblem[];
};

type Props = {
  project: NextProjectFile;
  disabled: boolean;
  onBusyChange: (busy: boolean) => void;
  onRestore: (next: NextProjectFile) => void;
};

async function inspect<T>(kind: "psd" | "wav", path: string): Promise<T> {
  const response = await fetch("/api/" + kind, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
  const data = await response.json() as T & { detail?: string };
  if (!response.ok) throw new Error(data.detail || "HTTP " + response.status);
  return data;
}

function why(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Separate v5-preview load/save path. Neither a v4 JSON nor existing editor state is overwritten. */
export default function ProductionProjectFiles({
  project, disabled, onBusyChange, onRestore,
}: Props) {
  const input = useRef<HTMLInputElement>(null);
  const operation = useRef(false);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<Staged | null>(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");

  function begin(): boolean {
    if (disabled || operation.current) return false;
    operation.current = true;
    setBusy(true);
    onBusyChange(true);
    setError("");
    return true;
  }
  function finish() {
    operation.current = false;
    setBusy(false);
    onBusyChange(false);
  }

  async function save() {
    if (!begin()) return;
    try {
      // Validation is synchronous; native file picker must retain the click activation.
      const json = serializeNextProjectFile(project);
      const outcome = await saveJsonFile(
        json, "tachie-production-project",
        "tachie-production-project.json", "複数キャラ制作プロジェクトJSON");
      setStatus(outcome.status === "saved"
        ? "複数キャラ制作プロジェクトを保存しました：" + outcome.filename
        : "保存をキャンセルしました。");
    } catch (failure) {
      setStatus("");
      setError("制作プロジェクトを保存できません：" + why(failure));
    } finally {
      finish();
    }
  }

  async function verify(candidate: Staged) {
    const result: NextProjectInspection = await inspectNextProjectSources(
      candidate.file, candidate.psdPaths, candidate.wavPaths,
      new Set(candidate.approved), inspect);
    if (result.problems.length) {
      setStage({ ...candidate, problems: result.problems });
      setStatus("参照元を確認してください。読み込み前の編集内容は保持しています。");
      return;
    }
    setStage({ ...candidate, problems: [] });
    if (!window.confirm("複数キャラ制作プロジェクトを読み込み、現在の制作画面の編集内容を置き換えますか？旧v4のセリフ画面や保存ファイルは変更しません。")) {
      setStatus("読み込みをキャンセルしました。現在の編集内容は保持しています。");
      return;
    }
    // This is a pure transformation. No project state is written until ALL checks pass.
    const validated = applyProductionInspection(
      candidate.file, result, candidate.psdPaths, candidate.wavPaths);
    onRestore(validated);
    setStage(null);
    setStatus("複数キャラ制作プロジェクトを読み込みました。");
  }

  async function load(file: File) {
    if (!begin()) return;
    setStatus("");
    try {
      if (file.size > MAX_NEXT_PROJECT_BYTES) {
        throw new Error("制作プロジェクトJSONが大きすぎます");
      }
      const parsed = parseNextProjectFile(await file.text());
      const candidate: Staged = {
        file: parsed,
        psdPaths: Object.fromEntries(parsed.characters.map((entry) =>
          [entry.id, entry.profile.source.path])),
        wavPaths: Object.fromEntries(parsed.wavs.map((entry) => [entry.id, entry.wavPath])),
        approved: [], problems: [],
      };
      setStage(candidate);
      await verify(candidate);
    } catch (failure) {
      setError("制作プロジェクトを読み込めません：" + why(failure));
    } finally {
      finish();
    }
  }

  async function retry() {
    if (!stage || !begin()) return;
    try { await verify(stage); }
    catch (failure) { setError("再確認できません：" + why(failure)); }
    finally { finish(); }
  }

  function updatePsd(id: string, path: string) {
    setStage((old) => old && { ...old, psdPaths: { ...old.psdPaths, [id]: path } });
  }
  function updateWav(id: string, path: string) {
    setStage((old) => old && ({
      ...old, wavPaths: { ...old.wavPaths, [id]: path },
      approved: old.approved.filter((entry) => entry !== id),
    }));
  }

  return <section className="project-controls" aria-label="複数キャラ制作プロジェクトJSON">
    <div className="project-file-actions">
      <button type="button" className="secondary" disabled={disabled || busy}
        onClick={() => { void save(); }}>制作JSONを保存</button>
      <button type="button" className="secondary" disabled={disabled || busy}
        onClick={() => input.current?.click()}>制作JSONを読み込む</button>
      <input ref={input} type="file" hidden id="production-project-input"
        aria-label="複数キャラ制作プロジェクトJSONファイル"
        accept=".json,application/json" disabled={disabled || busy}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file) void load(file);
        }} />
      {busy && <span role="status">制作プロジェクトを確認中…</span>}
    </div>
    {status && !busy && <p role="status" className="hint">{status}</p>}
    {error && <p role="alert" className="hint warning">{error}</p>}
    {stage && stage.problems.length > 0 && <div className="project-repair">
      <p>参照元が未確認です。修正または承認するまで現在の制作内容は置き換えません。</p>
      {stage.problems.map((problem) => {
        const isPsd = problem.kind === "psd";
        const path = isPsd ? stage.psdPaths[problem.key] : stage.wavPaths[problem.key];
        const isChanged = !isPsd && problem.message.includes("保存時からWAVが変更");
        return <div key={problem.kind + ":" + problem.key} className="project-repair-item">
          <p role="alert">{problem.kind.toUpperCase()} {problem.key}：{problem.message}</p>
          <NativeFilePicker
            id={"production-repair-" + problem.kind + "-" + problem.key}
            kind={problem.kind}
            label="参照する元ファイル" value={path ?? ""}
            disabled={disabled || busy}
            onPickStart={begin} onPickFinish={finish}
            onChange={(next) => isPsd ? updatePsd(problem.key, next) :
              updateWav(problem.key, next)}
            onSelected={(next) => {
              if (isPsd) updatePsd(problem.key, next); else updateWav(problem.key, next);
              return true;
            }} />
          {isChanged && <label>
            <input type="checkbox" checked={stage.approved.includes(problem.key)}
              disabled={disabled || busy}
              onChange={(event) => setStage((previous) => previous && ({
                ...previous,
                approved: event.target.checked
                  ? [...previous.approved, problem.key]
                  : previous.approved.filter((id) => id !== problem.key),
              }))} />
            このWAVの変更を明示的に承認する
          </label>}
        </div>;
      })}
      <div className="project-file-actions">
        <button type="button" disabled={disabled || busy}
          onClick={() => { void retry(); }}>再確認して読み込む</button>
        <button type="button" className="secondary" disabled={disabled || busy}
          onClick={() => { setStage(null); setStatus("読み込みを取り消しました。"); }}>
          読み込みを取り消す
        </button>
      </div>
    </div>}
  </section>;
}
