import {
  reorderProjectWavs, type CharacterWavAnimation, type NextProjectFile,
  resolveWaitPreset,
} from "./multiProjectFile";
import { removeProductionWav } from "./multiProjectEditing";
import { wavFilename } from "./utteranceItems";
import { MAX_PRESET_CHANGE_POINTS } from "./presetChangePoints";

type Props = {
  project: NextProjectFile;
  disabled: boolean;
  onEdit: (next: NextProjectFile) => void;
};

function changeAnimation(
  project: NextProjectFile, characterId: string, wavId: string,
  update: (old: CharacterWavAnimation) => CharacterWavAnimation,
): NextProjectFile {
  return { ...project, characters: project.characters.map((character) =>
    character.id !== characterId ? character : {
      ...character, animations: character.animations.map((entry) =>
        entry.wavId === wavId ? update(entry) : entry),
    }) };
}

export default function ProductionWavEditor({ project, disabled, onEdit }: Props) {
  const current = project.wavs.find((entry) => entry.id === project.selectedWavId);
  function updateWav(wavId: string, update: (old: NextProjectFile["wavs"][number]) =>
    NextProjectFile["wavs"][number]) {
    onEdit({ ...project, wavs: project.wavs.map((wav) =>
      wav.id === wavId ? update(wav) : wav) });
  }

  function setSpeaker(wavId: string, speakerId: string | null) {
    onEdit({
      ...project,
      wavs: project.wavs.map((wav) =>
        wav.id === wavId ? { ...wav, speakerId } : wav),
      // A non-speaker must not keep a formerly active lip-sync setting.
      characters: project.characters.map((character) => ({
        ...character, animations: character.animations.map((entry) =>
          entry.wavId === wavId && character.id !== speakerId ?
            { ...entry, lipMode: "none" as const } : entry),
      })),
    });
  }

  function setWait(wavId: string, waitAfter: boolean) {
    onEdit({
      ...project,
      wavs: project.wavs.map((wav) =>
        wav.id === wavId ? { ...wav, waitAfter } : wav),
      characters: waitAfter ? project.characters : project.characters.map((character) => ({
        ...character,
        waitOverrides: character.waitOverrides.filter((entry) => entry.wavId !== wavId),
      })),
    });
  }

  function setWaitPreset(charId: string, wavId: string, presetId: string) {
    onEdit({
      ...project,
      characters: project.characters.map((character) =>
        character.id !== charId ? character : {
          ...character,
          waitOverrides: [
            ...character.waitOverrides.filter((entry) => entry.wavId !== wavId),
            ...(presetId ? [{ wavId, presetId }] : []),
          ],
        }),
    });
  }

  return <section aria-label="共通WAVとキャラ別設定">
    <h2>共通WAV</h2>
    <p className="hint">WAVは1つの一覧で管理します。話者なしの音声も登録できます。</p>
    <ol className="utterance-list">
      {project.wavs.map((wav, index) => <li key={wav.id} data-production-wav-id={wav.id}>
        <div className="input-row">
          <button type="button" className="secondary"
            aria-pressed={project.selectedWavId === wav.id}
            disabled={disabled}
            onClick={() => onEdit({ ...project, selectedWavId: wav.id })}>
            {index + 1} {wavFilename(wav.wavPath)}
          </button>
          <button type="button" className="secondary" disabled={disabled || index === 0}
            aria-label={"WAVを上へ: " + wavFilename(wav.wavPath)}
            onClick={() => onEdit(reorderProjectWavs(project, wav.id, project.wavs[index - 1].id, false))}>
            ↑
          </button>
          <button type="button" className="secondary"
            disabled={disabled || index === project.wavs.length - 1}
            aria-label={"WAVを下へ: " + wavFilename(wav.wavPath)}
            onClick={() => onEdit(reorderProjectWavs(project, wav.id, project.wavs[index + 1].id, true))}>
            ↓
          </button>
          <button type="button" className="secondary" disabled={disabled}
            aria-label={"WAV登録を削除: " + wavFilename(wav.wavPath)}
            onClick={() => {
              if (window.confirm("WAVの登録と各キャラの対応する設定を削除しますか？元WAVは削除しません。")) {
                onEdit(removeProductionWav(project, wav.id));
              }
            }}>登録を削除</button>
        </div>
        <div className="input-row">
          <label>話者
            <select aria-label={"話者: " + wav.id} value={wav.speakerId ?? ""}
              disabled={disabled}
              onChange={(event) => setSpeaker(wav.id, event.target.value || null)}>
              <option value="">キャラなし</option>
              {project.characters.map((character) =>
                <option key={character.id} value={character.id}>{character.name}</option>)}
            </select>
          </label>
          <label>
            <input type="checkbox" checked={wav.waitAfter} disabled={disabled}
              aria-label={"待機あり: " + wav.id}
              onChange={(event) => setWait(wav.id, event.target.checked)} />
            このWAVの後に待機を入れる
          </label>
        </div>
      </li>)}
    </ol>
    {!current && <p className="hint">WAVを登録すると、キャラごとのプリセットと変更点を編集できます。</p>}
    {current && <div className="project-edit-section">
      <h2>選択したWAV：{wavFilename(current.wavPath)}</h2>
      {project.characters.map((character) => {
        const animation = character.animations.find((entry) => entry.wavId === current.id);
        if (!animation) return null;
        const presets = character.profile.collection.items;
        const presetOptions = presets.map((preset) =>
          <option key={preset.id} value={preset.id}>{preset.name}</option>);
        const currentOverride = character.waitOverrides.find((entry) => entry.wavId === current.id);
        return <section key={character.id} data-production-character-id={character.id}>
          <h3>{character.name} — {character.id === current.speakerId ? "話者" : "聞き手"}</h3>
          <div className="input-row">
            <label>初期プリセット
              <select aria-label={"初期プリセット: " + character.id}
                value={animation.presetId} disabled={disabled}
                onChange={(event) => onEdit(changeAnimation(
                  project, character.id, current.id, (old) =>
                    ({ ...old, presetId: event.target.value })))}>
                {presetOptions}
              </select>
            </label>
            <label>口パク方式
              <select aria-label={"口パク: " + character.id}
                value={animation.lipMode}
                disabled={disabled || current.speakerId !== character.id}
                onChange={(event) => onEdit(changeAnimation(
                  project, character.id, current.id, (old) => ({
                    ...old, lipMode: event.target.value as CharacterWavAnimation["lipMode"],
                  })))}>
                <option value="none">なし</option>
                <option value="open">open</option>
                <option value="aiueo">aiueo</option>
              </select>
            </label>
          </div>
          <div className="project-edit-section">
            <span>プリセット変更点（PCMサンプル位置）</span>
            <button type="button" className="secondary"
              disabled={disabled || current.wav.samples < 2 ||
                animation.presetChanges.length >= current.wav.samples - 1 ||
                animation.presetChanges.length >= MAX_PRESET_CHANGE_POINTS}
              onClick={() => {
                const used = new Set(animation.presetChanges.map((point) => point.sample));
                let sample = Math.max(1, Math.floor(current.wav.samples / 2));
                while (used.has(sample) && sample < current.wav.samples - 1) sample++;
                if (used.has(sample)) {
                  sample = 1;
                  while (used.has(sample)) sample++;
                }
                onEdit(changeAnimation(project, character.id, current.id, (old) => ({
                  ...old,
                  presetChanges: [...old.presetChanges,
                    { sample, presetId: old.presetId }].sort((a, b) => a.sample - b.sample),
                })));
              }}>＋ 変更点</button>
            {animation.presetChanges.map((point) => <div className="input-row"
              key={point.sample} data-production-change-sample={point.sample}>
              <label>サンプル位置
                <input aria-label={"変更点位置: " + character.id + ":" + point.sample}
                  type="number" min={1} max={current.wav.samples - 1} step={1}
                  value={point.sample} disabled={disabled}
                  onChange={(event) => {
                    const sample = Number(event.target.value);
                    onEdit(changeAnimation(project, character.id, current.id, (old) => ({
                      ...old, presetChanges: old.presetChanges.map((entry) =>
                        entry.sample === point.sample ? { ...entry, sample } : entry)
                        .sort((a, b) => a.sample - b.sample),
                    })));
                  }} />
              </label>
              <select aria-label={"変更先: " + character.id + ":" + point.sample}
                value={point.presetId} disabled={disabled}
                onChange={(event) => onEdit(changeAnimation(
                  project, character.id, current.id, (old) => ({
                    ...old, presetChanges: old.presetChanges.map((entry) =>
                      entry.sample === point.sample ?
                        { ...entry, presetId: event.target.value } : entry),
                  })))}>
                {presetOptions}
              </select>
              <button type="button" className="secondary" disabled={disabled}
                aria-label={"変更点削除: " + character.id + ":" + point.sample}
                onClick={() => onEdit(changeAnimation(
                  project, character.id, current.id, (old) => ({
                    ...old, presetChanges: old.presetChanges.filter((entry) =>
                      entry.sample !== point.sample),
                  })))}>削除</button>
            </div>)}
          </div>
          {current.waitAfter && <div className="input-row">
            <label>待機プリセット
              <select aria-label={"待機プリセット: " + character.id}
                disabled={disabled} value={currentOverride?.presetId ?? ""}
                onChange={(event) => setWaitPreset(character.id, current.id, event.target.value)}>
                <option value="">キャラ既定に連動</option>
                {presetOptions}
              </select>
            </label>
            <span className="hint">実際の待機表示：
              {presets.find((preset) => preset.id === resolveWaitPreset(
                project, character.id, current.id))?.name ?? "なし"}
            </span>
          </div>}
        </section>;
      })}
    </div>}
  </section>;
}
