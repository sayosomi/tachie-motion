import { useRef, useState } from "react";

// The in-progress text is already persisted by PresetWorkspace for crash
// recovery. Only a completed edit may update the preset's stable name.
export default function PresetNameEditor({
  name, draft, onDraftChange, onCommit,
}: {
  name: string;
  draft: string;
  onDraftChange: (value: string) => void;
  onCommit: (value: string) => string | null;
}) {
  const [error, setError] = useState("");
  const composing = useRef(false);

  function commit(value: string) {
    if (composing.current) return;
    if (value === name) {
      setError("");
      return;
    }
    setError(onCommit(value) ?? "");
  }

  return <>
    <label htmlFor="preset-name">名前</label>
    <div className="input-row">
      <input id="preset-name" value={draft}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? "preset-name-error" : "preset-name-status"}
        onChange={(event) => {
          setError("");
          onDraftChange(event.target.value);
        }}
        onCompositionStart={() => { composing.current = true; }}
        onCompositionEnd={(event) => {
          composing.current = false;
          if (document.activeElement !== event.currentTarget) {
            commit(event.currentTarget.value);
          }
        }}
        onBlur={(event) => commit(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || composing.current ||
              event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
          event.preventDefault();
          event.currentTarget.blur();
        }} />
    </div>
    {error ? <p id="preset-name-error" role="alert" className="hint warning">
      {error}
    </p> : <p id="preset-name-status" role="status" className="hint">
      {draft === name ? "保存済み" : "編集中（入力欄を離れると自動保存）"}
    </p>}
  </>;
}
