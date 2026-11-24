import { useRef, useState } from "react";
import { parseCharacterProfile, validateCharacterProfileOpenTargets } from "./characterProfile";
import { MAX_PROFILE_SIZE } from "./characterProfile";
import NativeFilePicker from "./NativeFilePicker";
import ProductionCharacterNameField from "./ProductionCharacterNameField";
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
  // Successful JSON import starts a new project generation. A Finder reply
  // initiated for an older generation cannot write into the new project.
  const projectEpoch = useRef(0);
  const pickerEpoch = useRef<number | null>(null);
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

  function beginPicker(): boolean {
    if (!begin()) return false;
    pickerEpoch.current = projectEpoch.current;
    return true;
  }
  function isCurrentPicker(): boolean {
    return pickerEpoch.current !== null && pickerEpoch.current === projectEpoch.current;
  }
  function finishPicker() {
    pickerEpoch.current = null;
    lock(false);
  }

  function edit(next: NextProjectFile): boolean {
    if (locked.current) return false;
    try {
      setProject(checkedProductionEdit(next));
      setError("");
      return true;
    } catch (failure) {
      setError(reason(failure));
      return false;
    }
  }

  async function addWav(path: string, fromFinder = false): Promise<boolean> {
    // From Finder, beginPicker already acquired the lock before /pick.
    if (fromFinder ? !isCurrentPicker() : !begin()) return false;
    try {
      const result = await inspect<WavData>("wav", path);
      if (fromFinder && !isCurrentPicker()) return false;
      const entry = {
        id: crypto.randomUUID(), wavPath: path, wav: result,
        speakerId: null, speakerManual: false,
        waitAfter: true, waitSecondsOverride: null,
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
      if (!fromFinder) lock(false);
      // Finder keeps the same lock until onPickFinish, after its callback.
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
    <p className="hint">複数キャラ制作JSONはv5専用です。旧v4の読込・変換には対応しません。
      この画面からMOV／OTIOはまだ書き出せません。</p>

    <ProductionProjectFiles project={project} disabled={busy}
      onBusyChange={lock} onRestore={(next) => {
        projectEpoch.current++;
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
        <label>基本セリフ間隔（秒）
          <input aria-label="共通待機秒数" disabled={busy}
            inputMode="decimal" value={project.waitSeconds}
            onChange={(event) => setProject((current) => ({
              ...current, waitSeconds: event.target.value,
            }))} />
        </label>
      </div>
      <div className="input-row">
        <label>書き出し解像度
          <select aria-label="書き出し解像度" disabled={busy}
            value={project.exportResolution}
            onChange={(event) => edit({
              ...project,
              exportResolution: event.target.value as NextProjectFile["exportResolution"],
            })}>
            <option value="original">原寸</option>
            <option value="half">1/2</option>
            <option value="quarter">1/4</option>
          </select>
        </label>
        <span className="hint">透過MOVと待機PNGに適用します。出力先は書き出し時に指定します。</span>
      </div>
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
            <ProductionCharacterNameField
              key={projectEpoch.current + ":" + character.id}
              characterId={character.id} name={character.name} disabled={busy}
              onCommit={(name) => edit({
                ...project, characters: project.characters.map((entry) =>
                  entry.id === character.id ? { ...entry, name } : entry),
              })} />
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
        onPickStart={beginPicker} onPickFinish={finishPicker}
        onChange={(path) => { if (!locked.current) setWavPath(path); }}
        onSelected={(path) => addWav(path, true)}
        onApply={() => { void addWav(wavPath); }} applyLabel="WAVを登録" />
    </section>
    <ProductionWavEditor project={project} disabled={busy} onEdit={edit} />
    {status && <p role="status" className="hint">{status}</p>}
    {error && <p role="alert" className="hint warning">{error}</p>}
  </main>;
}
