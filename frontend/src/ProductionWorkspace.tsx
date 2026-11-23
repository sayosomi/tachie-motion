import { useRef, useState } from "react";
import { parseCharacterProfile, validateCharacterProfileOpenTargets } from "./characterProfile";
import { MAX_PROFILE_SIZE } from "./characterProfile";
import NativeFilePicker from "./NativeFilePicker";
import ProductionProjectFiles from "./ProductionProjectFiles";
import ProductionWavEditor from "./ProductionWavEditor";
import {
  addProductionCharacter, addProductionWav, checkedProductionEdit,
  initialProductionProject, removeProductionCharacter,
} from "./multiProjectEditing";
import type { NextProjectFile } from "./multiProjectFile";
import type { Layer } from "./LayerTree";
import type { WavData } from "./utteranceItems";

type PsdInspection = { fingerprint: string; layers: Layer[] };

async function inspect<T>(kind: "psd" | "wav", path: string): Promise<T> {
  const response = await fetch("/api/" + kind, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
  const value = await response.json() as T & { detail?: string };
  if (!response.ok) throw new Error(value.detail || "HTTP " + response.status);
  return value;
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function ProductionWorkspace({
  onProjectBusyChange,
}: { onProjectBusyChange: (busy: boolean) => void }) {
  const [project, setProject] = useState<NextProjectFile>(initialProductionProject);
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const [wavPath, setWavPath] = useState("");
  const [newCharacterName, setNewCharacterName] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const profileInput = useRef<HTMLInputElement>(null);

  function lock(active: boolean) {
    locked.current = active;
    setBusy(active);
    onProjectBusyChange(active);
  }
  function begin(): boolean {
    if (locked.current) return false;
    lock(true);
    setStatus("");
    setError("");
    return true;
  }

  function edit(next: NextProjectFile) {
    if (locked.current) return;
    try {
      setProject(checkedProductionEdit(next));
      setError("");
    } catch (failure) {
      setError(reason(failure));
    }
  }

  async function addWav(path: string): Promise<boolean> {
    if (!begin()) return false;
    try {
      const result = await inspect<WavData>("wav", path);
      const entry = {
        id: crypto.randomUUID(), wavPath: path, wav: result,
        speakerId: null, waitAfter: true,
      };
      const next = addProductionWav(project, entry);
      setProject(next);
      setWavPath("");
      setStatus("WAVを登録しました。話者は「キャラなし」のままです。");
      return true;
    } catch (failure) {
      setError("WAVを登録できません：" + reason(failure));
      return false;
    } finally {
      lock(false);
    }
  }

  async function addProfile(file: File) {
    if (!begin()) return;
    try {
      if (file.size > MAX_PROFILE_SIZE) throw new Error("キャラクター設定JSONが大きすぎます");
      const profile = parseCharacterProfile(await file.text());
      const result = await inspect<PsdInspection>("psd", profile.source.path);
      if (result.fingerprint !== profile.source.fingerprint ||
          result.layers.length !== profile.source.layerPaths.length ||
          result.layers.some((entry, i) => entry.path !== profile.source.layerPaths[i])) {
        throw new Error("元PSDが保存時の内容と一致しません");
      }
      validateCharacterProfileOpenTargets(profile, result.layers);
      const fallbackName = profile.source.path.split(/[\\/]/).at(-1)?.replace(/\.psd$/i, "") ?? "";
      const name = newCharacterName.trim() || fallbackName;
      setProject(addProductionCharacter(project, crypto.randomUUID(), name, profile));
      setNewCharacterName("");
      setStatus("キャラクター設定を追加しました。元のJSONやPSDは変更していません。");
    } catch (failure) {
      setError("キャラクターを登録できません：" + reason(failure));
    } finally {
      lock(false);
    }
  }

  return <main className="app utterance-workspace production-workspace">
    <header className="topbar"><div className="brand">
      <span className="brand-mark">t</span><span>tachie-motion</span>
    </div></header>
    <div className="intro"><h1>制作プロジェクト（試作）</h1></div>
    <p className="hint">Issue #67の複数キャラ制作JSONを編集します。旧v4のセリフ画面・保存内容とは独立しています。
      この画面からMOV／OTIOはまだ書き出せません。</p>

    <ProductionProjectFiles project={project} disabled={busy}
      onBusyChange={lock} onRestore={(next) => {
        setProject(next);
        setWavPath("");
        setError("");
        setStatus("");
      }} />

    <section className="project-edit-section" aria-label="共通制作設定">
      <h2>制作共通設定</h2>
      <div className="input-row">
        <label>プロジェクト名
          <input aria-label="制作プロジェクト名" disabled={busy}
            value={project.naming.projectName}
            onChange={(event) => setProject((current) => ({
              ...current, naming: { ...current.naming, projectName: event.target.value },
            }))} />
        </label>
        <label>FPS
          <select aria-label="制作FPS" disabled={busy} value={project.fps}
            onChange={(event) => edit({ ...project,
              fps: Number(event.target.value) as NextProjectFile["fps"] })}>
            <option value={24}>24</option>
            <option value={30}>30</option>
            <option value={60}>60</option>
          </select>
        </label>
        <label>共通待機秒数
          <input aria-label="共通待機秒数" disabled={busy}
            inputMode="decimal" value={project.waitSeconds}
            onChange={(event) => setProject((current) => ({
              ...current, waitSeconds: event.target.value,
            }))} />
        </label>
      </div>
      <NativeFilePicker id="production-output-dir" kind="output_dir"
        label="出力先（後続の動画生成で使用）"
        value={project.naming.outputDir} disabled={busy}
        onChange={(path) => setProject((old) => ({
          ...old, naming: { ...old.naming, outputDir: path },
        }))}
        onSelected={(path) => {
          setProject((old) => ({ ...old, naming: { ...old.naming, outputDir: path } }));
          return true;
        }} />
    </section>

    <section className="project-edit-section" aria-label="キャラクター設定">
      <h2>キャラクター</h2>
      <p className="hint">既存のキャラクター設定JSON（v2）を読み込み、PSDの一致を確認して追加します。</p>
      <div className="input-row">
        <label>キャラ名
          <input aria-label="追加するキャラ名" value={newCharacterName}
            onChange={(event) => setNewCharacterName(event.target.value)}
            disabled={busy} placeholder="未入力ならPSD名" />
        </label>
        <button type="button" className="secondary" disabled={busy}
          onClick={() => profileInput.current?.click()}>キャラクター設定JSONを追加</button>
        <input type="file" hidden ref={profileInput} id="production-character-input"
          aria-label="追加するキャラクター設定JSONファイル"
          accept=".json,application/json" disabled={busy}
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            if (file) void addProfile(file);
          }} />
      </div>
      {project.characters.map((character) => <div key={character.id}
        data-production-character={character.id}>
        <div className="input-row">
          <label>キャラ名
            <input aria-label={"キャラ名: " + character.id}
              key={character.id} defaultValue={character.name} disabled={busy}
              onBlur={(event) => {
                if (event.target.value === character.name) return;
                edit({ ...project, characters: project.characters.map((entry) =>
                  entry.id === character.id ? { ...entry, name: event.target.value } : entry) });
              }} />
          </label>
          <label>既定プリセット
            <select aria-label={"既定プリセット: " + character.id}
              value={character.profile.collection.defaultId ?? ""}
              disabled={busy}
              onChange={(event) => edit({
                ...project,
                characters: project.characters.map((entry) =>
                  entry.id === character.id ? {
                    ...entry, profile: {
                      ...entry.profile, collection: {
                        ...entry.profile.collection, defaultId: event.target.value,
                      },
                    },
                  } : entry),
              })}>
              {character.profile.collection.items.map((preset) =>
                <option key={preset.id} value={preset.id}>{preset.name}</option>)}
            </select>
          </label>
          <button type="button" className="secondary" disabled={busy}
            aria-label={"キャラ登録を削除: " + character.id}
            onClick={() => {
              if (window.confirm("このキャラの演出設定を削除しますか？参照するWAVの話者は「キャラなし」になります。元PSD・JSONは削除しません。")) {
                edit(removeProductionCharacter(project, character.id));
              }
            }}>登録を削除</button>
        </div>
        <p className="hint">{character.profile.source.path}</p>
      </div>)}
    </section>

    <section className="project-edit-section" aria-label="WAV登録">
      <h2>WAVを追加</h2>
      <NativeFilePicker id="production-wav-path" kind="wav" label="音声WAV"
        value={wavPath} disabled={busy}
        onChange={setWavPath} onSelected={addWav}
        onApply={() => { void addWav(wavPath); }} applyLabel="WAVを登録" />
    </section>
    <ProductionWavEditor project={project} disabled={busy} onEdit={edit} />
    {status && <p role="status" className="hint">{status}</p>}
    {error && <p role="alert" className="hint warning">{error}</p>}
  </main>;
}
