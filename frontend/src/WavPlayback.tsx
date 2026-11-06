import { useEffect, useRef, useState } from "react";
import { wavFilename, type UtteranceItem } from "./utteranceItems";

type Source = Pick<UtteranceItem, "id" | "wavPath">;

export default function WavPlayback({
  items, selectedId,
}: { items: UtteranceItem[]; selectedId: string | null }) {
  const audio = useRef<HTMLAudioElement>(null);
  const pending = useRef<AbortController | null>(null);
  const objectUrl = useRef<string | null>(null);
  const generation = useRef(0);
  const playlist = useRef<Source[]>([]);
  const playlistIndex = useRef(0);
  const allMode = useRef(false);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [mode, setMode] = useState<"single" | "all" | null>(null);
  const [status, setStatus] = useState("");

  function discardSource() {
    pending.current?.abort();
    pending.current = null;
    if (audio.current) {
      audio.current.pause();
      audio.current.removeAttribute("src");
      audio.current.load();
    }
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    objectUrl.current = null;
  }

  function stop() {
    generation.current++;
    allMode.current = false;
    discardSource();
    setPlayingId(null);
    setMode(null);
    setStatus("");
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
    if (playingId && !items.some((item) => item.id === playingId)) stop();
  }, [items, playingId]);

  async function startSource(item: Source) {
    const epoch = ++generation.current;
    discardSource();
    setPlayingId(item.id);
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
      const data = await response.blob();
      if (epoch !== generation.current) return;
      const url = URL.createObjectURL(data);
      objectUrl.current = url;
      const player = audio.current;
      if (!player) return;
      player.src = url;
      await player.play();
      if (epoch === generation.current) setStatus("再生中: " + wavFilename(item.wavPath));
    } catch (error) {
      if (epoch !== generation.current) return;
      if (controller.signal.aborted) return;
      allMode.current = false;
      setMode(null);
      setPlayingId(null);
      setStatus("音声の再生に失敗: " + item.wavPath + " — " +
        (error instanceof Error ? error.message : String(error)));
    } finally {
      if (pending.current === controller) pending.current = null;
    }
  }

  function playSelected() {
    const item = items.find((entry) => entry.id === selectedId);
    if (!item) return;
    allMode.current = false;
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
    if (allMode.current && playlistIndex.current < playlist.current.length) {
      void startSource(playlist.current[playlistIndex.current++]);
    } else {
      allMode.current = false;
      setPlayingId(null);
      setMode(null);
      setStatus("再生が終了しました");
    }
  }

  return <section className="panel utterance-playback" aria-label="WAV試聴">
    <div className="utterance-list-header"><h2>WAV試聴</h2>
      <span className="meta">{mode === "all" ? "全件を一覧順に再生" :
        mode === "single" ? "選択中の1件を再生" : ""}</span>
    </div>
    <div className="utterance-playback-buttons">
      <button type="button" onClick={playSelected} disabled={!selectedId}>選択中を再生</button>
      <button type="button" onClick={playAll} disabled={items.length === 0}>全件を連続再生</button>
      <button type="button" onClick={stop} disabled={!playingId && !mode}>停止</button>
    </div>
    <audio ref={audio} controls preload="none" onEnded={onEnded}
      onPause={() => { if (playingId) setStatus("一時停止: " + wavFilename(
        items.find((item) => item.id === playingId)?.wavPath ?? "")); }}
      onPlay={() => { if (playingId) setStatus("再生中: " + wavFilename(
        items.find((item) => item.id === playingId)?.wavPath ?? "")); }}
      aria-label="選択したWAVの音声" />
    {status && <p className="hint" role="status">{status}</p>}
  </section>;
}
