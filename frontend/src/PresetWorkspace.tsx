import { useEffect, useRef, useState } from "react";
import type { Layer } from "./LayerTree";
import PresetDetail from "./PresetDetail";
import NativeFilePicker from "./NativeFilePicker";
import { PreviewSourceChangedError, useBrowserPreview } from "./useBrowserPreview";
import {
  appendPreset, availablePresetName, createPreset, duplicatePreset, movePreset,
  removeSessionPreset, renamePreset, reorderPresets, toggleBaseLayer,
  assignOpenLayerRole, type Presets, type UnifiedPreset,
} from "./presetModel";
import { matchesSource, readPresetDraft, writePresetDraft, type PresetDraft } from "./presetDraftStorage";
import {
  MAX_PROFILE_SIZE, matchesCharacterProfileSource, parseCharacterProfile,
  serializeCharacterProfile, validateCharacterProfileOpenTargets,
} from "./characterProfile";
import { saveCharacterProfileFile } from "./characterProfileSave";

type PsdData = {
  width: number; height: number; fingerprint: string; source_identity?: string;
  layers: Layer[]; preview: string;
};
type PreviewRecord = { signature: string; image?: string; error?: string };

async function api<T>(endpoint: string, payload: object): Promise<T> {
  const response = await fetch("/api/" + endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await response.json() as T & { detail?: string };
  if (!response.ok) throw new Error(data.detail || "HTTP " + response.status);
  return data;
}

function signature(preset: UnifiedPreset): string {
  return JSON.stringify(preset.base);
}

const empty: Presets = { items: [], defaultId: null };

export default function PresetWorkspace() {
  const [psdPath, setPsdPath] = useState("");
  const [loadedPath, setLoadedPath] = useState("");
  const [psd, setPsd] = useState<PsdData | null>(null);
  const { renderer: browserRenderer, sourceChanged, loading: previewLoading, verifySource } = useBrowserPreview(
    loadedPath, psd?.fingerprint ?? "", psd?.source_identity ?? "",
    psd?.width ?? 0, psd?.height ?? 0, psd?.layers ?? null,
  );
  const [collection, setCollection] = useState<Presets>(empty);
  const [previews, setPreviews] = useState<Record<string, PreviewRecord>>({});
  const [activeId, setActiveId] = useState<string | null>(
    () => new URLSearchParams(location.search).get("preset"),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [dirty, setDirty] = useState(false);
  const [nameDrafts, setNameDrafts] = useState<Record<string, string>>({});
  const [restoreMessage, setRestoreMessage] = useState("");
  const [profileMessage, setProfileMessage] = useState("");
  const [invalidRecovery, setInvalidRecovery] = useState(false);
  const [checkingRecovery, setCheckingRecovery] = useState(true);
  const savedRecovery = useRef<PresetDraft | null>(null);
  const profileFileInput = useRef<HTMLInputElement>(null);
  const savingProfileRef = useRef(false);
  const [savingProfile, setSavingProfile] = useState(false);
  const editVersion = useRef(0);
  const pendingNameEdit = collection.items.some((preset) =>
    Object.hasOwn(nameDrafts, preset.id) && nameDrafts[preset.id] !== preset.name);
  const hasUnsavedChanges = dirty || pendingNameEdit;

  // Re-read the source PSD after a refresh; never trust cached layer paths or
  // cached thumbnails. Failed restore must not overwrite the browser draft.
  useEffect(() => {
    let cancelled = false;
    let saved: PresetDraft | null = null;
    try { saved = readPresetDraft(); }
    catch (err) {
      setInvalidRecovery(true);
      setRestoreMessage((err instanceof Error ? err.message : String(err))
        + "。保存データは保持しています。");
    }
    savedRecovery.current = saved;
    if (!saved) {
      setCheckingRecovery(false);
      return;
    }
    const recovery = saved;
    setPsdPath(recovery.path);
    setBusy(true);
    api<PsdData>("psd", { path: recovery.path })
      .then((data) => {
        if (cancelled) return;
        if (!matchesSource(recovery, data.fingerprint, data.layers)) {
          setRestoreMessage("PSDが変更されています。保存済みの編集内容は保持していますが、復元はしていません。");
          return;
        }
        setPsd(data);
        setLoadedPath(recovery.path);
        setCollection(recovery.collection);
        setNameDrafts(recovery.nameDrafts);
        setPreviews({});
        setDirty(true);
        savedRecovery.current = null;
        setRestoreMessage("前回の編集を復元しました。");
      })
      .catch((err: unknown) => {
        if (!cancelled) setRestoreMessage(
          "PSDを開けず、復元できませんでした。ファイルを確認してから再読み込みしてください。保存済みデータは保持しています。"
          + (err instanceof Error ? " (" + err.message + ")" : ""),
        );
      }).finally(() => {
        if (!cancelled) { setBusy(false); setCheckingRecovery(false); }
      });
    return () => { cancelled = true; };
  }, []);

  function persist(next: Presets, drafts: Record<string, string> = nameDrafts,
    path: string = loadedPath, fingerprint: string | undefined = psd?.fingerprint) {
    if (!path || !fingerprint) return;
    try {
      writePresetDraft({ version: 1, path, fingerprint, collection: next, nameDrafts: drafts });
    } catch {
      setError("ブラウザに自動保存できません。再読み込み前に空き容量・保存設定を確認してください。");
    }
  }

  useEffect(() => {
    const sync = () => setActiveId(new URLSearchParams(location.search).get("preset"));
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);

  function navigate(id: string | null) {
    const next = new URL(window.location.href);
    if (id) next.searchParams.set("preset", id);
    else next.searchParams.delete("preset");
    window.history.pushState(null, "", next.pathname + next.search);
    setActiveId(id);
  }

  async function loadPsd(discardSaved = false, sourcePath?: string) {
    // Finder paths are exact, including significant leading/trailing spaces.
    // Trim only freeform manual input, never a value returned by the OS.
    const requested = sourcePath ?? psdPath.trim();
    if (!requested || busy || checkingRecovery) return false;
    if (sourceChanged && !discardSaved) {
      setError("元PSDが変更されています。旧レイヤー設定は自動適用しません。新規に読み込むには明示的に破棄を選んでください。");
      return false;
    }
    if (invalidRecovery && !discardSaved) {
      setError("保存済みデータが不正です。「保存済みを破棄して新規」を選ぶまで上書きしません。");
      return false;
    }
    const recovery = savedRecovery.current;
    const recoveringSameSource = !!recovery && !discardSaved && requested === recovery.path;
    if (discardSaved || (psd && (hasUnsavedChanges || requested !== loadedPath))
        || (recovery && !recoveringSameSource)) {
      if (!window.confirm("保存済みのプリセットを破棄してPSDを読み込みますか？")) return false;
    }
    const startingVersion = editVersion.current;
    setBusy(true);
    setError("");
    try {
      const data = await api<PsdData>("psd", { path: requested });
      if (!data.fingerprint) throw new Error("このWeb UIのAPIが古いため、プリセットを読み込めません");
      if (editVersion.current !== startingVersion) {
        throw new Error("PSD読み込み中にプリセットが変更されたため、読み込み結果を破棄しました。編集内容は保持しています。");
      }
      if (recoveringSameSource && recovery) {
        if (!matchesSource(recovery, data.fingerprint, data.layers)) {
          throw new Error("元PSDが変更されているため復元できません。保存済みデータは保持しています。");
        }
        setPsd(data);
        setLoadedPath(requested);
        setPsdPath(requested);
        setCollection(recovery.collection);
        setNameDrafts(recovery.nameDrafts);
        setPreviews({});
        setDirty(true);
        savedRecovery.current = null;
        setRestoreMessage("前回の編集を復元しました。");
        return true;
      }
      const first = createPreset("通常", data.layers);
      const next = appendPreset(empty, first);
      persist(next, {}, requested, data.fingerprint);
      setPsd(data);
      setLoadedPath(requested);
      setPsdPath(requested);
      setCollection(next);
      setNameDrafts({});
      setPreviews({ [first.id]: { signature: signature(first), image: data.preview } });
      setDirty(false);
      savedRecovery.current = null;
      setRestoreMessage("");
      setInvalidRecovery(false);
      navigate(null);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function saveCharacterProfile() {
    if (!psd || busy || checkingRecovery || savingProfileRef.current) return;
    if (pendingNameEdit) {
      setError("名前の編集中です。変更を確定してからJSONを保存してください。");
      return;
    }
    let json: string;
    try {
      json = serializeCharacterProfile(loadedPath, psd.fingerprint, psd.layers, collection);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return;
    }
    savingProfileRef.current = true;
    setSavingProfile(true);
    setError("");
    setProfileMessage("保存場所とファイル名を選択してください。");
    try {
      const result = await saveCharacterProfileFile(json);
      setProfileMessage(result.status === "saved"
        ? "JSONを保存しました：" + result.filename : "JSONの保存をキャンセルしました。");
    } catch (err) {
      setProfileMessage("");
      setError("JSONを保存できませんでした：" + (err instanceof Error ? err.message : String(err)));
    } finally {
      savingProfileRef.current = false;
      setSavingProfile(false);
    }
  }

  async function importCharacterProfile(file: File) {
    if (busy || checkingRecovery) return;
    const startVersion = editVersion.current;
    setBusy(true);
    setError("");
    setProfileMessage("");
    try {
      if (file.size > MAX_PROFILE_SIZE) throw new Error("キャラクター設定JSONが大きすぎます");
      const profile = parseCharacterProfile(await file.text());
      let data: PsdData;
      try {
        data = await api<PsdData>("psd", { path: profile.source.path });
      } catch {
        throw new Error("JSONが参照するPSDを開けません。元の場所にあるか確認してください。編集内容は保持しています。");
      }
      if (!matchesCharacterProfileSource(profile, profile.source.path, data.fingerprint, data.layers)) {
        throw new Error("PSDの内容またはレイヤー構造が保存時と一致しません。編集内容は保持しています。");
      }
      validateCharacterProfileOpenTargets(profile, data.layers);
      if (editVersion.current !== startVersion) {
        throw new Error("読込み中に編集内容が変更されたため、JSONの反映を中止しました。");
      }
      if ((psd || savedRecovery.current || invalidRecovery) &&
          !window.confirm("現在のプリセット編集内容を、選択したキャラクター設定JSONで置き換えますか？")) {
        return;
      }
      if (editVersion.current !== startVersion) {
        throw new Error("読込み中に編集内容が変更されたため、JSONの反映を中止しました。");
      }
      // Durable recovery write first: on storage failure keep the current UI.
      writePresetDraft({
        version: 1, path: profile.source.path, fingerprint: profile.source.fingerprint,
        collection: profile.collection, nameDrafts: {},
      });
      editVersion.current += 1;
      setPsd(data);
      setPsdPath(profile.source.path);
      setLoadedPath(profile.source.path);
      setCollection(profile.collection);
      setNameDrafts({});
      setPreviews({});
      setDirty(false);
      savedRecovery.current = null;
      setInvalidRecovery(false);
      setRestoreMessage("");
      setProfileMessage("キャラクター設定JSONを読み込みました。");
      navigate(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function changePsdPath(value: string) {
    // Keep the loaded PSD and unsaved edits until loading a new one is
    // explicitly confirmed. Preview uses loadedPath, never the draft input.
    setPsdPath(value);
  }

  function updatePresets(next: Presets, drafts: Record<string, string> = nameDrafts) {
    if (sourceChanged || next === collection) return;
    editVersion.current += 1;
    persist(next, drafts);
    setCollection(next);
    setDirty(true);
  }

  function changeNameDraft(id: string, name: string) {
    editVersion.current += 1;
    const drafts = { ...nameDrafts, [id]: name };
    persist(collection, drafts);
    setNameDrafts(drafts);
  }

  const pending = psd && collection.items.find((preset) => {
    const cache = previews[preset.id];
    return !cache || cache.signature !== signature(preset);
  });

  // Only the exact current state can publish an image. A stale source halts
  // BOTH Canvas and legacy requests until the user explicitly reloads.
  useEffect(() => {
    if (!psd || !pending || sourceChanged || previewLoading) return;
    const preset = pending, sig = signature(preset);
    let cancelled = false;
    let timer: number | undefined;
    const legacy = () => {
      timer = window.setTimeout(() => {
        void (async () => {
          try {
            await verifySource();
            if (cancelled) return;
            const result = await api<{ preview: string }>("preset-preview", {
              path: loadedPath, fingerprint: psd.fingerprint,
              source_identity: psd.source_identity, layers: preset.base,
            });
            if (!cancelled) setPreviews((previous) => ({
              ...previous, [preset.id]: { signature: sig, image: result.preview },
            }));
          } catch (err) {
            if (!cancelled && !(err instanceof PreviewSourceChangedError))
              setPreviews((previous) => ({
                ...previous, [preset.id]: {
                  signature: sig, error: err instanceof Error ? err.message : String(err),
                },
              }));
          }
        })();
      }, 250);
    };
    if (browserRenderer) {
      void browserRenderer.render(preset.base).then((image) => {
        if (!cancelled) setPreviews((previous) => ({
          ...previous, [preset.id]: { signature: sig, image },
        }));
      }).catch((err: unknown) => {
        // Explicit stale result is not an ordinary rendering fallback:
        // the old index paths must never be submitted against a new PSD.
        if (!cancelled && !(err instanceof PreviewSourceChangedError)) legacy();
      });
    } else {
      legacy();
    }
    return () => { cancelled = true; if (timer !== undefined) window.clearTimeout(timer); };
  }, [psd, loadedPath, pending?.id, pending && signature(pending), browserRenderer, sourceChanged, previewLoading, verifySource]);

  function add() {
    if (!psd) return;
    const preset = createPreset(availablePresetName(collection, "新しいプリセット"), psd.layers);
    updatePresets(appendPreset(collection, preset));
    setPreviews((old) => ({
      ...old, [preset.id]: { signature: signature(preset), image: psd.preview },
    }));
    navigate(preset.id);
  }

  function duplicate(id: string) {
    const next = duplicatePreset(collection, id);
    const copy = next.items.find((preset) => !collection.items.some((old) => old.id === preset.id));
    if (!copy) return;
    updatePresets(next);
    const sourceCache = previews[id];
    if (sourceCache && sourceCache.signature === signature(copy)) {
      setPreviews((old) => ({ ...old, [copy.id]: { ...sourceCache } }));
    }
    navigate(copy.id);
  }

  function remove(id: string) {
    const name = collection.items.find((preset) => preset.id === id)?.name;
    if (!name || !window.confirm("プリセット「" + name + "」を削除しますか？")) return;
    const drafts = { ...nameDrafts };
    delete drafts[id];
    updatePresets(removeSessionPreset(collection, id), drafts);
    setNameDrafts(drafts);
    setPreviews((old) => {
      const next = { ...old };
      delete next[id];
      return next;
    });
    if (activeId === id) navigate(null);
  }

  const active = collection.items.find((item) => item.id === activeId);
  const activePreview = !sourceChanged && active
    && previews[active.id]?.signature === signature(active)
    ? previews[active.id] : undefined;

  return <main className="app preset-workspace" data-preview-renderer={sourceChanged ? "stale" : previewLoading ? "loading" : browserRenderer ? "canvas" : "python"}>
    <header className="topbar">
      <div className="brand"><span className="brand-mark">t</span><span>tachie-motion</span></div>
    </header>
    <div className="intro"><h1>プリセット</h1></div>
    <p className="notice session-notice" role="note">このブラウザに自動保存します。PSD原本は変更しません。</p>
    {checkingRecovery && <p role="status" className="hint">前回の編集を確認中…</p>}
    {restoreMessage && <p role="status" className="hint">{restoreMessage}</p>}
    {(invalidRecovery || savedRecovery.current || sourceChanged) && !busy && <button
      type="button" className="secondary" onClick={() => { void loadPsd(true); }}>
      保存済みを破棄して新規
    </button>}
    {error && <p className="notice error" role="alert">{error}</p>}
    {sourceChanged && <p className="notice error" role="alert">
      PSDの外部変更または同一性確認の失敗を検出しました。古いプレビューを停止しました。PSDを再読み込みしてください。
      編集内容は自動保存された状態のまま保持しています。
    </p>}
    <section className="panel preset-import">
      <div className="panel-heading"><h2>PSD</h2></div>
      <NativeFilePicker id="preset-psd-path" kind="psd" label="立ち絵PSD"
        value={psdPath} disabled={busy || checkingRecovery}
        onChange={changePsdPath}
        onSelected={(path) => loadPsd(false, path)}
        onApply={() => { void loadPsd(); }} applyLabel={busy ? "読み込み中…" : "読み込む"} />
      {psd && <p className="meta">キャンバス {psd.width} × {psd.height} px ／ レイヤー {psd.layers.length}件</p>}
      {psd && psdPath !== loadedPath && <p className="hint warning">新しいPSDパスを入力中です。読み込むまでは現在のプリセットを保持します。</p>}
    </section>
    <section className="panel character-profile-actions">
      <div className="panel-heading">
        <h2>キャラクター設定</h2>
        <div className="profile-file-actions">
          <button type="button" className="secondary" onClick={() => { void saveCharacterProfile(); }}
            disabled={!psd || busy || checkingRecovery || savingProfile}>{savingProfile ? "保存中…" : "JSONを保存"}</button>
          <button type="button" className="secondary"
            disabled={busy || checkingRecovery || savingProfile}
            onClick={() => profileFileInput.current?.click()}>JSONを読み込む</button>
          <input ref={profileFileInput} id="character-profile-file" type="file" hidden
            accept=".json,application/json" disabled={busy || checkingRecovery || savingProfile}
            aria-label="キャラクター設定JSONファイル"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = "";
              if (file) void importCharacterProfile(file);
            }} />
        </div>
      </div>
      <p className="hint profile-hint">保存時にファイル名と保存先を選択できます。読み込みには元のPSDが必要です。</p>
      {profileMessage && <p className="hint profile-status" role="status">{profileMessage}</p>}
    </section>
    {psd && active ? <PresetDetail
      preset={active} layers={psd.layers} preview={activePreview?.image}
      browserRenderer={browserRenderer} sourceChanged={sourceChanged}
       previewLoading={previewLoading} verifySource={verifySource}
       sourceIdentity={psd.source_identity}
      sourcePath={loadedPath} fingerprint={psd.fingerprint}
      canvasWidth={psd.width} canvasHeight={psd.height}
      nameDraft={Object.hasOwn(nameDrafts, active.id)
        ? nameDrafts[active.id] : active.name}
      onNameDraftChange={(name) => changeNameDraft(active.id, name)}
      previewError={activePreview?.error} onBack={() => navigate(null)}
      onRename={(name) => { try {
        const nextDrafts = { ...nameDrafts };
        delete nextDrafts[active.id];
        updatePresets(renamePreset(collection, active.id, name), nextDrafts);
        setNameDrafts(nextDrafts);
        setError("");
      } catch (e) { setError(e instanceof Error ? e.message : String(e)); } }}
      onToggle={(path) => updatePresets(toggleBaseLayer(collection, active.id, path))}
      onOpenRoleChange={(path, role) => updatePresets(assignOpenLayerRole(collection, active.id, path, role))}
      onDelete={() => remove(active.id)}
    /> : psd && <section className="panel preset-list-section">
      <div className="preset-list-header">
        <h2>一覧</h2>
        <button type="button" className="primary preset-add" onClick={add}>＋ 作成</button>
      </div>
      {collection.items.length === 0 && <p className="empty-state">プリセットがありません。</p>}
      <div className="preset-cards">
        {collection.items.map((preset, index) => {
          const cache = previews[preset.id];
          const thumb = !sourceChanged && cache?.signature === signature(preset)
            ? cache.image : undefined;
          return <div key={preset.id} className="preset-card" data-preset-id={preset.id}
            onDragOver={(e) => { if (e.dataTransfer.types.includes("text/x-tachie-preset")) e.preventDefault(); }}
            onDrop={(e) => {
              e.preventDefault();
              const source = e.dataTransfer.getData("text/x-tachie-preset");
              if (source) updatePresets(reorderPresets(collection, source, preset.id));
            }}>
            <div className="preset-card-image">
              {thumb ? <img src={thumb} alt={preset.name + " のプレビュー"} /> :
                <span>{sourceChanged ? "PSDを再読み込みしてください" :
                  cache?.error || "プレビューを更新中…"}</span>}
            </div>
            <div className="preset-card-body">
              <div className="preset-card-title">
                <button type="button" className="preset-drag-handle" draggable
                  aria-label={preset.name + " をドラッグして並び替え"}
                  title="ここをドラッグして並び替え"
                  onDragStart={(e) => {
                    e.dataTransfer.effectAllowed = "move";
                    e.dataTransfer.setData("text/x-tachie-preset", preset.id);
                  }}>⠿</button>
                <strong>{preset.name}</strong>
                {collection.defaultId === preset.id && <span className="preset-default-label">既定</span>}
              </div>
              <div className="preset-card-buttons">
                <button type="button" onClick={() => navigate(preset.id)}>詳細を編集</button>
                <button type="button" className="secondary" onClick={() => duplicate(preset.id)}>複製</button>
                <button type="button" className="secondary" disabled={collection.defaultId === preset.id}
                  onClick={() => updatePresets({ ...collection, defaultId: preset.id })}>既定にする</button>
              </div>
              <div className="preset-order-actions">
                <span className="hint preset-order-label">順番</span>
                <button type="button" className="secondary" disabled={index === 0}
                  aria-label={preset.name + " を上へ移動"}
                  onClick={() => updatePresets(movePreset(collection, preset.id, -1))}>↑</button>
                <button type="button" className="secondary" disabled={index === collection.items.length - 1}
                  aria-label={preset.name + " を下へ移動"}
                  onClick={() => updatePresets(movePreset(collection, preset.id, 1))}>↓</button>
                <button type="button" className="secondary" onClick={() => remove(preset.id)}>削除</button>
              </div>
            </div>
          </div>;
        })}
      </div>
    </section>}
    {!psd && !checkingRecovery && !restoreMessage && <p className="hint preset-empty">PSDを読み込んでください。</p>}
  </main>;
}
