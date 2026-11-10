import { useEffect, useRef, useState, type ReactNode } from "react";
import { wavFilename, type UtteranceItem } from "./utteranceItems";

type Source = Pick<UtteranceItem, "id" | "wavPath">;
export type WavPlaybackControls = {
  activeId: string | null;
  paused: boolean;
  loading: boolean;
  mode: "single" | "all" | null;
  elapsed: number;
  status: string;
  toggleItem: (id: string) => void;
  playAll: () => void;
  stop: () => void;
  seek: (seconds: number) => void;
  audioElement: ReactNode;
};

/** Playback owns the one audio element. Buttons and progress live in each WAV row. */
export default function useWavPlayback(items: UtteranceItem[]): WavPlaybackControls {
  const audio = useRef<HTMLAudioElement>(null);
  const pending = useRef<AbortController | null>(null);
  const objectUrl = useRef<string | null>(null);
  const source = useRef<Source | null>(null);
  const generation = useRef(0);
  const playlist = useRef<Source[]>([]);
  const playlistIndex = useRef(0);
  const allMode = useRef(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<"single" | "all" | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [status, setStatus] = useState("");

  function discardSource() {
    pending.current?.abort();
    pending.current = null;
    const previousUrl = objectUrl.current;
    objectUrl.current = null; // Events raised by pause/load during cleanup are not errors.
    source.current = null;
    if (audio.current) {
      audio.current.pause();
      audio.current.removeAttribute("src");
      audio.current.load();
    }
    if (previousUrl) URL.revokeObjectURL(previousUrl);
  }

  function stop() {
    generation.current++;
    allMode.current = false;
    playlist.current = [];
    discardSource();
    setActiveId(null);
    setMode(null);
    setPaused(false);
    setLoading(false);
    setElapsed(0);
    setStatus("");
  }

  function failPlayback(item: Source, reason: string) {
    generation.current++;
    allMode.current = false;
    playlist.current = [];
    discardSource();
    setActiveId(null);
    setMode(null);
    setPaused(false);
    setLoading(false);
    setElapsed(0);
    setStatus("音声の再生に失敗: " + item.wavPath + " — " + reason);
  }

  function onMediaError() {
    if (!objectUrl.current || !source.current) return;
    const item = source.current;
    const problem = audio.current?.error;
    failPlayback(item, problem ? "メディアエラー (" + problem.code + ")" :
      "メディアの読み込み・デコードエラー");
  }

  useEffect(() => {
    return () => {
      generation.current++;
      pending.current?.abort();
      if (audio.current) audio.current.pause();
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    };
  }, []);

  useEffect(() => {
    if (activeId && !items.some((item) => item.id === activeId)) stop();
  }, [items, activeId]);

  async function startSource(item: Source) {
    const epoch = ++generation.current;
    discardSource();
    source.current = item;
    setActiveId(item.id);
    setPaused(false);
    setLoading(true);
    setElapsed(0);
    setStatus("音声を読み込み中: " + wavFilename(item.wavPath));
    const controller = new AbortController();
    pending.current = controller;
    try {
      const response = await fetch("/api/wav-playback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: item.wavPath }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const detail = await response.json().catch(() => null) as { detail?: string } | null;
        throw new Error(detail?.detail || "HTTP " + response.status);
      }
      const wav = await response.blob();
      if (epoch !== generation.current) return;
      const url = URL.createObjectURL(wav);
      objectUrl.current = url;
      const player = audio.current;
      if (!player) return;
      player.src = url;
      await player.play();
      if (epoch === generation.current) {
        setLoading(false);
        setStatus("再生中: " + wavFilename(item.wavPath));
      }
    } catch (error) {
      if (epoch !== generation.current || controller.signal.aborted) return;
      failPlayback(item, error instanceof Error ? error.message : String(error));
    } finally {
      if (pending.current === controller) pending.current = null;
    }
  }

  function resume() {
    const item = source.current;
    if (!item || !audio.current || !objectUrl.current) return;
    void audio.current.play().catch((error: unknown) => {
      if (item.id === source.current?.id) {
        failPlayback(item, error instanceof Error ? error.message : String(error));
      }
    });
  }

  function toggleItem(id: string) {
    const item = items.find((entry) => entry.id === id);
    if (!item) return;
    // Clicking an already-loading row is cancellation, not a second fetch.
    // Check the active source ref as well as React state for rapid repeated clicks.
    if (source.current?.id === id && (loading || (pending.current !== null && !objectUrl.current))) {
      stop();
      return;
    }
    if (id === activeId && objectUrl.current) {
      if (audio.current?.paused) resume();
      else audio.current?.pause();
      return;
    }
    allMode.current = false;
    playlist.current = [];
    setMode("single");
    void startSource(item);
  }

  function playAll() {
    if (!items.length) return;
    playlist.current = items.map(({ id, wavPath }) => ({ id, wavPath }));
    playlistIndex.current = 1;
    allMode.current = true;
    setMode("all");
    void startSource(playlist.current[0]);
  }

  function onEnded() {
    if (!source.current || !objectUrl.current) return;
    if (allMode.current && playlistIndex.current < playlist.current.length) {
      void startSource(playlist.current[playlistIndex.current++]);
    } else {
      generation.current++;
      allMode.current = false;
      playlist.current = [];
      discardSource();
      setActiveId(null);
      setMode(null);
      setPaused(false);
      setLoading(false);
      setElapsed(0);
      setStatus("再生が終了しました");
    }
  }

  function seek(seconds: number) {
    const player = audio.current;
    if (player && objectUrl.current && Number.isFinite(seconds)) {
      player.currentTime = Math.max(0, Math.min(seconds, player.duration || seconds));
      setElapsed(player.currentTime);
    }
  }

  const audioElement = <div className="utterance-playback" hidden>
    <audio ref={audio} preload="none" onEnded={onEnded} onError={onMediaError}
      onTimeUpdate={() => setElapsed(audio.current?.currentTime ?? 0)}
      onPause={() => {
        if (!objectUrl.current || !source.current) return;
        setPaused(true);
        setLoading(false);
        setStatus("一時停止: " + wavFilename(source.current.wavPath));
      }}
      onPlay={() => {
        if (!objectUrl.current || !source.current) return;
        setPaused(false);
        setLoading(false);
        setStatus("再生中: " + wavFilename(source.current.wavPath));
      }}
      aria-label="WAV試聴プレーヤー" />
  </div>;

  return { activeId, paused, loading, mode, elapsed, status, toggleItem, playAll, stop, seek,
    audioElement };
}
