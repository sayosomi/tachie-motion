import { useEffect, useRef, useState } from "react";
import type { Layer } from "./LayerTree";
import UtteranceExportPanel, { type ExportScope } from "./UtteranceExportPanel";
import UtteranceList from "./UtteranceList";
import ProjectActions from "./ProjectActions";
import { projectPresetDraft, type ProjectFile } from "./projectFile";
import type { ProjectInspection } from "./projectRestore";
import useWavPlayback from "./WavPlayback";
import { useBatchUtteranceExport } from "./useBatchUtteranceExport";
import { exportPayload, exportReady } from "./utteranceExportRequest";
import type { UnifiedPreset } from "./presetModel";
import { matchesSource, readPresetDraft, writePresetDraft, type PresetDraft } from "./presetDraftStorage";
import {
  createUtterance, moveUtterance, reorderUtterances, updateUtterance,
  type ExportData, type UtteranceItem, type WavData,
} from "./utteranceItems";

type PsdData = { fingerprint: string; layers: Layer[] };
type Destination = {
  state: "available" | "complete" | "partial" | "unsafe" | "recovery_required";
  suggested_basename: string;
};
type DestinationCheck = { key: string; info: Destination };

async function post<T>(route: string, payload: object): Promise<T> {
  const res = await fetch("/api/" + route, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json() as T & { detail?: string };
  if (!res.ok) throw new Error(data.detail || "HTTP " + res.status);
  return data;
}

function openMouthReady(preset?: UnifiedPreset): boolean {
  const mouth = preset?.openMouth;
  return Boolean(mouth && mouth.closed.length > 0 &&
    mouth.closed.length === mouth.opened.length &&
    JSON.stringify(mouth.closed) !== JSON.stringify(mouth.opened));
}

export default function UtteranceWorkspace({ active = true, onProjectBusyChange }: {
  active?: boolean;
  onProjectBusyChange?: (busy: boolean) => void;
}) {
  const [draft, setDraft] = useState<PresetDraft | null>(null);
  const [psdLayers, setPsdLayers] = useState<Layer[]>([]);
  const [projectBusy, setProjectBusy] = useState(false);
  const projectBusyRef = useRef(false);
  const [items, setItems] = useState<UtteranceItem[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [pendingPath, setPendingPath] = useState("");
  const [defaultOutputDir, setDefaultOutputDir] = useState("");
  const [startupError, setStartupError] = useState("");
  const [presetStatus, setPresetStatus] = useState<"loading" | "ready" | "error">("loading");
  const [addError, setAddError] = useState("");
  const [addingCount, setAddingCount] = useState(0);
  const [exportingId, setExportingId] = useState<string | null>(null);
  const [exportScope, setExportScope] = useState<ExportScope>("single");
  const [destination, setDestination] = useState<DestinationCheck | null>(null);
  const [destinationError, setDestinationError] = useState("");
  const [probeVersion, setProbeVersion] = useState(0);
  const sequence = useRef(0);
  const latestAdd = useRef(0);
  const catalogEpoch = useRef(0);
  const selectionEpoch = useRef(0);
  const mounted = useRef(false);
  // Synchronous guard closes the gap before React commits exportingId state.
  const singleExportLock = useRef(false);
  const batch = useBatchUtteranceExport(draft, items, setItems,
    () => setProbeVersion((previous) => previous + 1), active && exportScope === "all");
  const playback = useWavPlayback(items);
  const editingLocked = batch.running || batch.isBusy() || !!exportingId || projectBusy;
  const projectLock = (locked: boolean) => {
    projectBusyRef.current = locked;
    if (locked) catalogEpoch.current++; // Invalidate any older asynchronous WAV addition.
    setProjectBusy(locked);
    onProjectBusyChange?.(locked);
  };
  // A stale DOM event may run before React commits running/exportingId.
  const isEditBusy = () => editingLocked || projectBusyRef.current ||
    singleExportLock.current || batch.isBusy();

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  // Keep the WAV list mounted across the Presets/Speech tabs. Refresh the
  // character snapshot when returning; reject changed PSDs, do not reuse a stale draft.
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setStartupError("");
    setPresetStatus("loading");
    setDraft(null); // Block export until the returning preset snapshot is revalidated.
    const load = async () => {
      try {
        const saved = readPresetDraft();
        if (!saved || saved.collection.items.length === 0) {
          throw new Error("最初に「プリセット」でPSDとプリセットを設定してください");
        }
        const [psd, health] = await Promise.all([
          post<PsdData>("psd", { path: saved.path }),
          fetch("/api/health").then(async (response) => {
            if (!response.ok) throw new Error("出力設定を取得できません");
            return response.json() as Promise<{ default_output_dir: string }>;
          }),
        ]);
        if (!matchesSource(saved, psd.fingerprint, psd.layers)) {
          throw new Error("PSDが変更されています。「プリセット」で読み込み直してください");
        }
        if (cancelled) return;
        setDraft(saved);
        setPsdLayers(psd.layers);
        setPresetStatus("ready");
        setDefaultOutputDir(health.default_output_dir);
      } catch (err) {
        if (cancelled) return;
        setDraft(null);
        setPresetStatus("error");
        setStartupError(err instanceof Error ? err.message : String(err));
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [active]);

  // Commit a validated project snapshot only after the browser storage write
  // succeeds. Failed imports leave WAV rows and preset recovery untouched.
  function restoreProject(project: ProjectFile, inspected: ProjectInspection,
    psdPath: string, wavPaths: Record<string, string>) {
    if (!inspected.psd || inspected.problems.length) {
      throw new Error("素材の確認が完了していません");
    }
    const nextDraft = projectPresetDraft(project, psdPath);
    writePresetDraft(nextDraft);
    playback.stop();
    latestAdd.current++;
    catalogEpoch.current++;
    selectionEpoch.current++;
    sequence.current = Math.max(0, ...project.items.map((item) => item.registrationOrder));
    setItems(project.items.map((item) => ({
      ...item, wavPath: wavPaths[item.id] ?? item.wavPath,
      wav: inspected.wavs[item.id], result: null, error: "",
    })));
    setActiveId(project.selectedId);
    setDraft(nextDraft);
    setPsdLayers(inspected.psd.layers);
    setPresetStatus("ready");
    setStartupError("");
    setAddError("");
    setPendingPath("");
    setExportScope("single");
    setDestination(null);
    setDestinationError("");
    setProbeVersion((previous) => previous + 1);
  }

  const current = items.find((item) => item.id === activeId);
  const selected = draft?.collection.items.find((preset) => preset.id === current?.presetId);

  function selectItem(id: string) {
    selectionEpoch.current++;
    setActiveId(id);
  }

  function revise(id: string, patch: Partial<UtteranceItem>): boolean {
    if (isEditBusy()) return false;
    setItems((previous) => updateUtterance(previous, id, patch));
    return true;
  }

  async function addWav(path: string): Promise<boolean> {
    if (isEditBusy()) return false;
    if (!draft || !path.trim()) {
      setAddError("WAVのパスを指定してください");
      return false;
    }
    const request = ++latestAdd.current;
    const atEpoch = selectionEpoch.current;
    const atCatalog = catalogEpoch.current;
    const ordinal = ++sequence.current;
    setAddingCount((count) => count + 1);
    try {
      const wav = await post<WavData>("wav", { path });
      if (!mounted.current || atCatalog !== catalogEpoch.current) return false;
      const id = crypto.randomUUID();
      const presetId = draft.collection.defaultId ?? draft.collection.items[0].id;
      const item = createUtterance(id, path, wav, presetId, defaultOutputDir, ordinal);
      // Preserve the order of registration even when two analyses complete backwards.
      setItems((previous) => {
        const at = previous.findIndex((entry) => entry.registrationOrder > ordinal);
        return at < 0 ? [...previous, item] :
          [...previous.slice(0, at), item, ...previous.slice(at)];
      });
      if (request === latestAdd.current && selectionEpoch.current === atEpoch) {
        setActiveId(id);
      }
      setPendingPath((value) => value === path ? "" : value);
      return true;
    } catch (err) {
      if (mounted.current && atCatalog === catalogEpoch.current) {
        const reason = err instanceof Error ? err.message : String(err);
        // A newer WAV may have succeeded before this request failed.
        // Preserve every failure with its source path instead of dropping stale responses.
        setAddError((previous) => {
          const message = `${path}: ${reason}`;
          return previous ? `${previous} ／ ${message}` : message;
        });
      }
      return false;
    } finally {
      if (mounted.current) setAddingCount((count) => count - 1);
    }
  }

  async function addManyWavs(paths: string[]): Promise<boolean> {
    if (isEditBusy()) return false;
    // Analyze in parallel while keeping registration order by the allocated sequence ID.
    // Partial failures remain visible with their original paths.
    const outcomes = await Promise.all(paths.map((path) => addWav(path)));
    return outcomes.some(Boolean);
  }

  function removeItem(id: string) {
    const index = items.findIndex((item) => item.id === id);
    if (index < 0 || isEditBusy()) return;
    setItems((previous) => previous.filter((item) => item.id !== id));
    if (activeId === id) {
      selectionEpoch.current++;
      setActiveId(items[index + 1]?.id ?? items[index - 1]?.id ?? null);
    }
  }

  const destinationKey = current
    ? current.id + "\\0" + current.outputDir + "\\0" + current.basename : "";
  useEffect(() => {
    let cancelled = false;
    if (!current || !current.outputDir.trim() ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(current.basename)) {
      setDestination(null);
      setDestinationError("");
      return;
    }
    setDestination(null);
    setDestinationError("");
    void post<Destination>("preset-utterance-destination", {
      output_dir: current.outputDir, basename: current.basename,
    }).then((info) => {
      if (!cancelled) setDestination({ key: destinationKey, info });
    }).catch((err: unknown) => {
      if (!cancelled) setDestinationError(err instanceof Error ? err.message : String(err));
    });
    return () => { cancelled = true; };
  }, [destinationKey, probeVersion]);

  const info = destination?.key === destinationKey ? destination.info : undefined;
  const requiresAlternate = !!info && info.state !== "available" &&
    (info.state !== "complete" || current?.conflictChoice === "rename");
  const saveAsName = current?.saveAsName ?? info?.suggested_basename ?? "";
  const outputBasename = requiresAlternate ? saveAsName : current?.basename ?? "";
  const conflictPolicy = info?.state === "complete" && !requiresAlternate
    ? "overwrite" : "error";
  const allowed = !!current && exportReady(selected, current);
  const canExport = !!draft && !!current && allowed && !editingLocked &&
    !singleExportLock.current && addingCount === 0 &&
    !!info && !destinationError &&
    /^[A-Za-z0-9_-]{1,64}$/.test(outputBasename) &&
    (!requiresAlternate || outputBasename !== current.basename);

  async function exportUtterance() {
    if (!draft || !current || !selected || !canExport || isEditBusy()) return;
    singleExportLock.current = true;
    const itemId = current.id;
    setExportingId(itemId);
    setItems((previous) => updateUtterance(previous, itemId, {}));
    try {
      const result = await post<ExportData>("preset-utterance-export",
        exportPayload(draft, current, selected, outputBasename, conflictPolicy));
      if (mounted.current) setItems((previous) => previous.map((item) =>
        item.id === itemId ? { ...item, result, error: "" } : item));
    } catch (err) {
      if (mounted.current) setItems((previous) => previous.map((item) =>
        item.id === itemId ? { ...item, result: null,
          error: err instanceof Error ? err.message : String(err) } : item));
    } finally {
      singleExportLock.current = false;
      if (mounted.current) {
        setExportingId(null);
        setProbeVersion((previous) => previous + 1);
      }
    }
  }

  const canApplyToAll = !!current && !!selected && exportReady(selected, current) &&
    !editingLocked && addingCount === 0 && items.length > 1;

  function applySelectedAnimationToAll() {
    if (!canApplyToAll || isEditBusy() || !current) return;
    if (!window.confirm("選択中のプリセットと口パク方式を全WAVへ適用しますか？他のWAVのプリセットと口パク方式だけを変更し、fps・出力先・ファイル名は変更しません。")) return;
    setItems((previous) => previous.map((item) =>
      item.presetId === current.presetId && item.mode === current.mode ? item :
        { ...item, presetId: current.presetId, mode: current.mode, result: null, error: "" }));
  }

  return <main className="app utterance-workspace">
    <header className="topbar"><div className="brand"><span className="brand-mark">t</span>
      <span>tachie-motion</span></div></header>
    <div className="intro"><h1>セリフ</h1></div>
    <p className="hint utterance-scope">WAVを複数登録し、選択したセリフを個別に編集・試聴できます。全件のMOV・個別OTIOの一括書き出しに対応します。aiueo・瞬き・待機・変更点・全体OTIOは後続対応です。</p>
    {startupError && <p className="notice error" role="alert">{startupError}</p>}
    <UtteranceList items={items} presets={draft?.collection.items ?? []}
      projectControls={<ProjectActions
        draft={draft} layers={psdLayers} items={items} selectedId={activeId}
        disabled={editingLocked || addingCount > 0 || presetStatus === "loading"}
        onBusyChange={projectLock} onRestore={restoreProject} />}
      presetStatus={presetStatus}
      selectedId={activeId} pendingPath={pendingPath}
      addingCount={addingCount} addError={addError}
      disabled={!draft || editingLocked} exportingId={exportingId} playback={playback}
      onPathChange={setPendingPath} onAdd={addWav} onAddMany={addManyWavs}
      onSelect={selectItem} onRevise={revise}
      onMove={(id, delta) => {
        if (isEditBusy() || addingCount > 0) return;
        setItems((previous) => moveUtterance(previous, id, delta));
      }}
      onReorder={(from, to, after) => {
        if (isEditBusy() || addingCount > 0) return;
        setItems((previous) => reorderUtterances(previous, from, to, after));
      }}
      onRemove={removeItem} canApplyToAll={canApplyToAll}
      onApplyToAll={applySelectedAnimationToAll} />
    <UtteranceExportPanel
        items={items} current={current} draftAvailable={!!draft}
        openMouthMissing={current?.mode === "open" && !openMouthReady(selected)}
        blinkUnsupported={!!selected?.blinkEnabled}
        info={info} destinationError={destinationError}
        requiresAlternate={requiresAlternate} saveAsName={saveAsName}
        outputBasename={outputBasename} canExport={canExport}
        exportingId={exportingId} addingCount={addingCount}
        scope={exportScope} onScopeChange={setExportScope}
        onRevise={revise} onSingleExport={() => { void exportUtterance(); }}
        batch={batch} />
  </main>;
}
