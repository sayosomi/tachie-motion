import { useEffect, useState } from "react";

export type PickerKind = "psd" | "wav" | "output_dir";
type Props = {
  id: string;
  kind: PickerKind;
  label: string;
  value: string;
  disabled?: boolean;
  multiple?: boolean;
  onSelectedMany?: (paths: string[]) => void | boolean | Promise<void | boolean>;
  onChange: (path: string) => void;
  onSelected: (path: string) => void | boolean | Promise<void | boolean>;
  applyLabel?: string;
  onApply?: () => void | Promise<void>;
};

const PICKER = "http://127.0.0.1:8766";
const recentDirectoryKey = (kind: PickerKind) => "tachie-motion.picker-dir.v1." + kind;

function lastDirectory(kind: PickerKind): string | undefined {
  try {
    const stored = localStorage.getItem(recentDirectoryKey(kind));
    return stored && stored.startsWith("/") && stored.length <= 4096 ? stored : undefined;
  } catch {
    return undefined;
  }
}

function rememberDirectory(kind: PickerKind, selectedPath: string) {
  const trimmed = selectedPath.replace(/\/+$/, "") || "/";
  const directory = kind === "output_dir" ? trimmed :
    trimmed.slice(0, trimmed.lastIndexOf("/")) || "/";
  if (!directory.startsWith("/") || directory.length > 4096) return;
  try { localStorage.setItem(recentDirectoryKey(kind), directory); }
  catch { /* Selection still works if the browser blocks localStorage. */ }
}

const localEditor = (location.hostname === "127.0.0.1" || location.hostname === "localhost") &&
  location.protocol === "http:" && location.port === "8765";

export default function NativeFilePicker({
  id, kind, label, value, disabled = false, multiple = false,
  onSelectedMany, onChange, onSelected, applyLabel, onApply,
}: Props) {
  const [available, setAvailable] = useState(false);
  const [picking, setPicking] = useState(false);
  const [pickerError, setPickerError] = useState("");

  useEffect(() => {
    if (!localEditor) return;
    const abort = new AbortController();
    fetch(PICKER + "/health", { signal: abort.signal, mode: "cors" })
      .then(async (response) => {
        const status = await response.json() as { ready?: boolean; picker?: string };
        if (response.ok && status.ready === true && status.picker === "mac-local") {
          setAvailable(true);
        }
      }).catch(() => { /* Native picker is optional in the plain Web launcher. */ });
    return () => abort.abort();
  }, []);

  async function choose() {
    if (!localEditor || !available || disabled || picking) return;
    setPicking(true);
    setPickerError("");
    try {
      const response = await fetch(PICKER + "/pick", {
        method: "POST", mode: "cors",
        headers: { "Content-Type": "application/json", "X-Tachie-Picker": "1" },
        body: JSON.stringify({ kind, initial_dir: lastDirectory(kind), ...(multiple ? { multiple: true } : {}) }),
      });
      const answer = await response.json() as {
        status?: "selected" | "cancelled"; path?: string; paths?: string[]; detail?: string;
      };
      if (!response.ok) throw new Error(answer.detail || "Finderを開けませんでした");
      if (answer.status === "cancelled") return;
      if (answer.status !== "selected") {
        throw new Error("ファイル選択の応答が不正です");
      }
      if (multiple) {
        const paths = Array.isArray(answer.paths) ? answer.paths : answer.path ? [answer.path] : undefined;
        if (!onSelectedMany || !Array.isArray(paths) || paths.length === 0 ||
            paths.length > 256 || paths.some((path) => typeof path !== "string" || !path.startsWith("/"))) {
          throw new Error("複数ファイルの選択結果が不正です");
        }
        const accepted = await onSelectedMany(paths);
        if (accepted === false) return;
        rememberDirectory(kind, paths[0]);
      } else {
        if (!answer.path) throw new Error("ファイル選択の応答が不正です");
        // Rejected PSD switches must retain the previously remembered directory.
        const accepted = await onSelected(answer.path);
        if (accepted === false) return;
        rememberDirectory(kind, answer.path);
      }
    } catch (err) {
      setPickerError(err instanceof Error ? err.message : String(err));
    } finally {
      setPicking(false);
    }
  }

  return <div className="native-file-picker">
    <div className="picker-header">
      <span className="picker-label">{label}</span>
      <button type="button" className="secondary picker-choose"
        disabled={disabled || picking || !available} onClick={() => { void choose(); }}>
        {picking ? "選択中…" : kind === "output_dir" ? "フォルダを選ぶ" : "Finderで選ぶ"}
      </button>
    </div>
    {value && <p className="picker-selected" title={value}>{value.split("/").filter(Boolean).at(-1) || value}</p>}
    {!available && <p className="hint">
      {localEditor ? "Finder選択を使うにはMac専用ランチャーで起動してください。" :
        "Finder選択はMac本体のブラウザで利用できます。"}
    </p>}
    {pickerError && <p role="alert" className="hint warning">{pickerError}</p>}
    <details className="picker-manual" id={id + "-advanced"}>
      <summary>パスを直接入力（補助）</summary>
      <div className="input-row">
        <input id={id} value={value} disabled={disabled || picking}
          onChange={(e) => onChange(e.target.value)}
          placeholder={kind === "output_dir" ? "/Users/.../Movies" :
            kind === "psd" ? "/Volumes/.../character.psd" : "/Volumes/.../voice.wav"} />
        {onApply && <button type="button" disabled={disabled || picking || !value.trim()}
          onClick={() => { void onApply(); }}>{applyLabel || "読み込む"}</button>}
      </div>
    </details>
  </div>;
}
