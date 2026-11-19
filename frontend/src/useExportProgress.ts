import { useCallback, useEffect, useState } from "react";

export type ExportPhase = "running" | "cancelling" | "finalizing"
  | "success" | "failed" | "cancelled";
export type ExportProgressView = {
  token: string;
  names: string[];
  phase: ExportPhase;
  stage: string;
  percent: number;
  index: number;
  frames: number;
  frameTotal: number;
  detail: string;
  connectionError: boolean;
};
type ServerProgress = {
  status: ExportPhase;
  stage: string;
  percent: number;
  index: number;
  total: number;
  frames: number;
  frame_total: number;
  can_cancel: boolean;
};
const terminal = (phase: ExportPhase) =>
  phase === "success" || phase === "failed" || phase === "cancelled";

export function useExportProgress() {
  const [view, setView] = useState<ExportProgressView | null>(null);

  const begin = useCallback((token: string, names: string[]) => {
    setView({
      token, names, phase: "running", stage: "準備・素材確認", percent: 0,
      index: 1, frames: 0, frameTotal: 0, detail: "", connectionError: false,
    });
  }, []);

  const settle = useCallback((outcome: "success" | "failed" | "cancelled",
    detail = "") => {
    setView((previous) => previous ? {
      ...previous,
      phase: previous.phase === "success" ? "success" : outcome,
      percent: outcome === "success" ? 100 : previous.percent,
      stage: outcome === "success" ? "書き出し完了" :
        outcome === "cancelled" ? "書き出しをキャンセルしました" : "書き出しに失敗しました",
      detail: detail || previous.detail,
    } : null);
  }, []);

  useEffect(() => {
    if (!view?.token || terminal(view.phase)) return;
    const token = view.token;
    let active = true;
    let pending = false;
    async function refresh() {
      if (pending) return;
      pending = true;
      try {
        const response = await fetch("/api/export-progress/" + encodeURIComponent(token));
        if (response.status === 404) return; // POST may still be entering the server.
        if (!response.ok) throw new Error("進捗取得に失敗");
        const state = await response.json() as ServerProgress;
        if (!active) return;
        setView((previous) => {
          if (!previous || previous.token !== token || terminal(previous.phase)) return previous;
          return {
            ...previous, phase: state.status, stage: state.stage,
            percent: Math.max(previous.percent, Math.min(100, state.percent)),
            index: state.index, frames: state.frames, frameTotal: state.frame_total,
            connectionError: false,
          };
        });
      } catch {
        if (active) setView((previous) => previous?.token === token
          ? { ...previous, connectionError: true } : previous);
      } finally {
        pending = false;
      }
    }
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 300);
    return () => { active = false; window.clearInterval(timer); };
  }, [view?.token, view?.phase]);

  const cancel = useCallback(async () => {
    const current = view;
    if (!current || current.phase !== "running") return;
    setView((previous) => previous?.token === current.token
      ? { ...previous, phase: "cancelling", stage: "キャンセルを要求中" } : previous);
    try {
      const response = await fetch("/api/export-cancel", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: current.token }),
      });
      if (!response.ok) throw new Error("キャンセル要求に失敗しました");
      const result = await response.json() as { accepted: boolean; status: ExportPhase };
      if (result.accepted === false) {
        setView((previous) => previous?.token === current.token && !terminal(previous.phase)
          ? { ...previous, phase: result.status, stage: "最終保存処理中" } : previous);
      }
      // "accepted" means requested, not cancelled. Wait for the worker to stop.
    } catch {
      setView((previous) => previous?.token === current.token && !terminal(previous.phase)
        ? { ...previous, connectionError: true,
            detail: "キャンセル要求を確認できません。処理状態を再取得しています。" }
        : previous);
    }
  }, [view]);

  const close = useCallback(() => {
    setView((previous) => previous && terminal(previous.phase) ? null : previous);
  }, []);

  return { view, begin, settle, cancel, close };
}
