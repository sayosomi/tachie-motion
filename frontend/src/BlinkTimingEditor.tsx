import { useEffect, useState } from "react";
import { validBlinkTiming, SUGGESTED_BLINK_TIMING, type BlinkTiming } from "./blinkTiming";

const FIELDS = [
  ["intervalMs", "間隔（秒）"],
  ["closedMs", "閉眼時間（秒）"],
  ["jitterMs", "間隔の揺らぎ（±秒）"],
  ["phaseMs", "最初の瞬きまで（秒）"],
] as const;

type Inputs = Record<keyof BlinkTiming, string>;

function toInputs(timing?: BlinkTiming): Inputs {
  const example = timing ?? SUGGESTED_BLINK_TIMING;
  return {
    intervalMs: String(example.intervalMs / 1000),
    closedMs: String(example.closedMs / 1000),
    jitterMs: String(example.jitterMs / 1000),
    phaseMs: String(example.phaseMs / 1000),
    seed: String(example.seed),
  };
}

/** Form examples remain unsaved until the user explicitly saves them. */
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
      seed: Number(values.seed),
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
      {timing ? "保存済みの設定を表示しています。" : "目安として3秒間隔・閉眼0.12秒・揺らぎ±0.5秒・初回0.7秒を入力済みです。"}
      保存ボタンを押すまで書き出しには反映されません。</p>
    {FIELDS.map(([key, label]) => <label key={key}>
      {label}
      <input type="number" min="0" max="600" step="0.001"
        aria-label={label} value={values[key]}
        onChange={(event) => {
          setValues((previous) => ({ ...previous, [key]: event.target.value }));
          setMessage("");
        }} />
    </label>)}
    <label>再現用シード（整数）
      <input type="number" step="1" aria-label="再現用シード（整数）"
        value={values.seed} onChange={(event) => {
          setValues((previous) => ({ ...previous, seed: event.target.value }));
          setMessage("");
        }} />
    </label>
    <button type="button" onClick={save}>瞬き時間を保存</button>
    {message && <p className="hint" role="status">{message}</p>}
  </fieldset>;
}
