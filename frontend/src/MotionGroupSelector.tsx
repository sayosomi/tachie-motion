import { useState } from "react";
import type { Layer } from "./LayerTree";

type Props = {
  groups: Layer[];
  selected: string[];
  onChange: (groups: string[]) => void;
};

export default function MotionGroupSelector({ groups, selected, onChange }: Props) {
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState("");
  const names = groups.filter((group) => selected.includes(group.path))
    .map((group) => group.name);

  function change(path: string, checked: boolean) {
    try {
      onChange(checked
        ? [...selected, path]
        : selected.filter((current) => current !== path));
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return <div className="motion-group-selector">
    <div className="motion-group-header">
      <div className="motion-group-summary">
        <strong>対象グループ</strong>
        <span>{names.length ? names.join("、") : "未選択"}</span>
      </div>
      <button type="button" className="secondary" aria-expanded={editing}
        onClick={() => { setEditing((previous) => !previous); setError(""); }}>
        {editing ? "閉じる" : "変更"}
      </button>
    </div>
    {editing && <div className="motion-group-choices" role="group" aria-label="PSDグループ">
      {groups.map((group) => <label key={group.path} className="motion-group-choice"
        style={{ paddingLeft: 8 + 12 * (group.path.split("/").length - 1) }}>
        <input type="checkbox" checked={selected.includes(group.path)}
          aria-label={group.name + " [" + group.path + "]"}
          onChange={(event) => change(group.path, event.target.checked)} />
        {group.name}
      </label>)}
      {groups.length === 0 && <p className="hint">PSDにレイヤーグループがありません。</p>}
    </div>}
    {error && <p className="hint warning" role="alert">{error}</p>}
  </div>;
}
