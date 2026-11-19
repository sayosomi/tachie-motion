import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { ExportProgressView } from "./useExportProgress";

type Props = {
  progress: ExportProgressView | null;
  onCancel: () => void;
  onClose: () => void;
};
const terminal = (status: ExportProgressView["phase"]) =>
  status === "success" || status === "failed" || status === "cancelled";

export default function ExportProgressDialog({ progress, onCancel, onClose }: Props) {
  const dialog = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!progress) return;
    const focusBefore = document.activeElement instanceof HTMLElement
      ? document.activeElement : null;
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialog.current?.focus();
    const blockOutside = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
      }
      if (event.key !== "Tab" || !dialog.current) return;
      const controls = [...dialog.current.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
      if (controls.length === 0) {
        event.preventDefault();
        dialog.current.focus();
        return;
      }
      if (event.shiftKey && document.activeElement === controls[0]) {
        event.preventDefault();
        controls[controls.length - 1].focus();
      } else if (!event.shiftKey && document.activeElement === controls[controls.length - 1]) {
        event.preventDefault();
        controls[0].focus();
      }
    };
    document.addEventListener("keydown", blockOutside, true);
    return () => {
      document.removeEventListener("keydown", blockOutside, true);
      document.body.style.overflow = originalOverflow;
      focusBefore?.focus();
    };
  }, [!!progress]);

  useEffect(() => {
    if (progress && terminal(progress.phase)) closeButton.current?.focus();
  }, [progress?.phase]);

  if (!progress) return null;
  const ended = terminal(progress.phase);
  const title = progress.phase === "success" ? "書き出し完了" :
    progress.phase === "failed" ? "書き出しに失敗しました" :
    progress.phase === "cancelled" ? "書き出しをキャンセルしました" :
    progress.phase === "cancelling" ? "キャンセル処理中" :
    progress.phase === "finalizing" ? "最終保存・検証中" : "書き出し中";
  const filename = progress.names[Math.min(progress.names.length - 1, progress.index - 1)]
    ?? "対象ファイルを確認中";

  return createPortal(<div className="export-progress-backdrop">
    <div className="export-progress-dialog" role="dialog" aria-modal="true"
      aria-label={title} aria-describedby="export-progress-stage"
      tabIndex={-1} ref={dialog}>
      <h2 className="export-progress-title">{title}</h2>
      <div className="export-progress-percent" aria-live="off">
        {progress.percent}<span>%</span>
      </div>
      <div className="export-progress-track" role="progressbar"
        aria-label="書き出しの進捗" aria-valuemin={0} aria-valuemax={100}
        aria-valuenow={progress.percent}>
        <div className="export-progress-fill" style={{ width: progress.percent + "%" }} />
      </div>
      <p id="export-progress-stage" className="export-progress-stage" aria-live="polite">
        {progress.stage}
      </p>
      <div className="export-progress-details">
        <p>対象：{progress.names.length === 1 ? "1件" :
          progress.index + " / " + progress.names.length + "件"}</p>
        <p className="export-progress-filename">{filename}</p>
        {progress.frameTotal > 0 && <p>フレーム送信：
          {progress.frames} / {progress.frameTotal}</p>}
      </div>
      <p className="export-progress-disclaimer">処理済みフレームと完了工程から算出した進捗です。
        残り時間を保証するものではありません。</p>
      {progress.connectionError && <p className="export-progress-notice" role="alert">
        進捗またはキャンセル要求の通信を確認できません。結果を確認しています。
      </p>}
      {progress.detail && <p className="export-progress-notice" role="alert">
        {progress.detail}
      </p>}
      <div className="export-progress-actions">
        {ended ? <button ref={closeButton} type="button" className="primary"
          onClick={onClose}>編集画面に戻る</button> :
          progress.phase === "running"
            ? <button type="button" onClick={onCancel}>書き出しをキャンセル</button>
            : <span aria-live="polite">{progress.phase === "cancelling"
              ? "安全に停止するまで処理しています…" : "公開と復旧処理が完了するまでお待ちください"}</span>}
      </div>
    </div>
  </div>, document.body);
}
