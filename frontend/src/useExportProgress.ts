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

const STORAGE_KEY = "tachie-motion-active-export-progress";

function restoreView(): ExportProgressView | null {
  try {
    const stored = window.sessionStorage.getItem(STORAGE_KEY);
    if (!stored) return null;
    const data = JSON.parse(stored) as { token?: unknown; names?: unknown };
    if (typeof data.token !== "string" ||
        !/^[A-Za-z0-9_-]{20,100}$/.test(data.token) ||
        !Array.isArray(data.names) || data.names.length < 1 ||
        data.names.length > 2000 ||
        !data.names.every((name) => typeof name === "string" &&
          name.length <= 1024)) return null;
    return { token: data.token, names: data.names, phase: "running",
      stage: "サーバーの処理状態を再確認中", percent: 0, index: 1,
      frames: 0, frameTotal: 0, detail: "",
      connectionError: false };
  } catch { return null; }
}

export function useExportProgress() {
  const [view, setView] = useState<ExportProgressView | null>(restoreView);

  useEffect(() => {
    try {
      if (!view || terminal(view.phase)) window.sessionStorage.removeItem(STORAGE_KEY);
      else window.sessionStorage.setItem(STORAGE_KEY,
        JSON.stringify({ token: view.token, names: view.names }));
    } catch { /* Storage is optional: server-side safety does not depend on it. */ }
  }, [view?.token, view?.phase, view?.names]);

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
      // A server-confirmed terminal outcome wins over a late HTTP error.
      phase: terminal(previous.phase) ? previous.phase : outcome,
      percent: terminal(previous.phase) ? previous.percent :
        outcome === "success" ? 100 : previous.percent,
      stage: terminal(previous.phase) ? previous.stage :
        outcome === "success" ? "書き出し完了" :
        outcome === "cancelled" ? "書き出しをキャンセルしました" : "書き出しに失敗しました",
      detail: terminal(previous.phase) ? previous.detail : detail || previous.detail,
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
            ...previous,
            phase: previous.phase === "cancelling" && state.status === "running"
              ? "cancelling" : state.status,
            stage: previous.phase === "cancelling" && state.status === "running"
              ? "キャンセル処理中" : state.stage,
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

  const uncertain = useCallback((detail: string) => {
    // A dropped HTTP connection is not proof that the worker stopped.
    setView((previous) => previous && !terminal(previous.phase)
      ? { ...previous, connectionError: true, detail } : previous);
  }, []);

  const cancel = useCallback(async () => {
    const current = view;
    if (!current || current.phase !== "running") return;
    setView((previous) => previous?.token === current.token
      ? { ...previous, phase: "cancelling", stage: "キャンセルを要求中" } : previous);
    try {
      let response: Response | null = null;
      for (let retry = 0; retry < 12; retry++) {
        response = await fetch("/api/export-cancel", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: current.token }),
        });
        if (response.status !== 404) break;
        // The solo POST may still be entering its export lock. Retrying
        // the same unguessable token is safe and avoids losing an early click.
        await new Promise<void>((done) => window.setTimeout(done, 150));
      }
      if (!response?.ok) throw new Error("キャンセル対象を確認できません");
      const result = await response.json() as { accepted: boolean; status: ExportPhase };
      if (result.accepted === false) {
        setView((previous) => previous?.token === current.token && !terminal(previous.phase)
          ? { ...previous, phase: result.status, stage: "最終保存処理中" } : previous);
      }
      // "accepted" means requested, not cancelled. Wait for the worker to stop.
    } catch {
      setView((previous) => previous?.token === current.token && !terminal(previous.phase)
        ? { ...previous, phase: "running", connectionError: true,
            detail: "キャンセル要求を確認できません。進捗を確認して再操作してください。" }
        : previous);
    }
  }, [view]);

  const close = useCallback(() => {
    setView((previous) => previous && terminal(previous.phase) ? null : previous);
  }, []);

  return { view, begin, settle, uncertain, cancel, close };
}
