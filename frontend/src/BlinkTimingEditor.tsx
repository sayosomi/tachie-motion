import { useEffect, useState } from "react";
import { validBlinkTiming, type BlinkTiming } from "./blinkTiming";

const FIELDS = [
  ["intervalMs", "間隔（秒）"],
  ["closedMs", "閉眼時間（秒）"],
  ["jitterMs", "間隔の揺らぎ（±秒）"],
  ["phaseMs", "最初の瞬きの目安（秒）"],
] as const;

type Inputs = Record<"intervalMs" | "closedMs" | "jitterMs" | "phaseMs", string>;

function toInputs(timing?: BlinkTiming): Inputs {
  // No saved timing must never masquerade as filled-in, usable values.
  const example = timing;
  return {
    intervalMs: example ? String(example.intervalMs / 1000) : "",
    closedMs: example ? String(example.closedMs / 1000) : "",
    jitterMs: example ? String(example.jitterMs / 1000) : "",
    phaseMs: example ? String(example.phaseMs / 1000) : "",
  };
}

/** Saved initial values and later edits share the same source of truth. */
export default function BlinkTimingEditor({
  timing, onSave,
}: {
  timing?: BlinkTiming;
  onSave: (timing: BlinkTiming) => boolean;
}) {
  const [values, setValues] = useState<Inputs>(() => toInputs(timing));
  const [message, setMessage] = useState("");
  useEffect(() => { setValues(toInputs(timing)); }, [timing]);

  function save() {
    const numeric = {
      intervalMs: Number(values.intervalMs) * 1000,
      closedMs: Number(values.closedMs) * 1000,
      jitterMs: Number(values.jitterMs) * 1000,
      phaseMs: Number(values.phaseMs) * 1000,
      // Keep the existing JSON field; it is no longer used to reproduce MOV timing.
      seed: timing?.seed ?? 0,
    };
    if (Object.values(values).some((value) => value.trim() === "") ||
        !validBlinkTiming(numeric)) {
      setMessage("数値が不正です。間隔は閉眼時間＋揺らぎより長くしてください。");
      return;
    }
    if (!onSave(numeric)) {
      setMessage("保存できませんでした。画面上部のエラーを確認してください。");
      return;
    }
    setMessage("キャラクター共通の瞬き設定を保存しました。");
  }

  return <fieldset className="blink-timing-editor">
    <legend>瞬きの時間設定（キャラクター共通）</legend>
    <p className="hint">全プリセットで同じ時間設定を使い、ON/OFFだけをプリセット別に切り替えます。
      {timing ? "初期値または変更済みの保存設定を表示しています。編集した場合は保存してください。"
        : "瞬き時間を読み込めません。PSDの読み込み状態を確認してください。"}
      最初の瞬きも間隔も、指定の揺らぎ幅で書き出しごとに変化します。
      同じWAVの再書き出しでも瞬きは変わります。保存済みの値が書き出しに反映されます。</p>
    {FIELDS.map(([key, label]) => <label key={key}>
      {label}
      <input type="number" min="0" max="600" step="0.001"
        aria-label={label} value={values[key]}
        onChange={(event) => {
          setValues((previous) => ({ ...previous, [key]: event.target.value }));
          setMessage("");
        }} />
    </label>)}
     <button type="button" onClick={save}>瞬き時間を保存</button>
    {message && <p className="hint" role="status">{message}</p>}
  </fieldset>;
}
