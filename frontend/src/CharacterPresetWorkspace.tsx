import { useEffect, useRef, useState } from "react";
import PresetWorkspace from "./PresetWorkspace";
import type { UtteranceItem } from "./utteranceItems";
import { readPresetDraft, type PresetDraftStore } from "./presetDraftStorage";
import {
  CHARACTER_DRAFT_CATALOG_KEY, addCharacterDraftGroup, commitCharacterDraftCatalog,
  readCharacterDraftCatalog, renameCharacterDraftGroup, selectCharacterDraftGroup,
  updateCharacterDraftGroup, type CatalogSnapshot, type CharacterDraftCatalog,
} from "./characterDraftCatalog";

type Props = {
  utterances: readonly UtteranceItem[];
  isWavRegistrationPending: () => boolean;
};
const noPendingWavs = () => false;
const noUtterances: readonly UtteranceItem[] = [];

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Each character owns its preset recovery snapshot. The existing legacy
 * single-character editor and export path retain their original storage. */
export default function CharacterPresetWorkspace(props: Props) {
  const snapshotRef = useRef<CatalogSnapshot | null>(null);
  const ownsLock = useRef(false);
  const generation = useRef(0);
  const [snapshot, setSnapshot] = useState<CatalogSnapshot | null>(null);
  const [access, setAccess] = useState<"loading" | "ready" | "unavailable">("loading");
  const [error, setError] = useState("");
  const [form, setForm] = useState<"add" | "copy" | "rename" | null>(null);
  const [name, setName] = useState("");

  useEffect(() => {
    let disposed = false;
    let release: (() => void) | undefined;
    const abort = new AbortController();
    if (!navigator.locks) {
      setAccess("unavailable");
      setError("このブラウザはキャラ別プリセットの排他編集に対応していません。従来の単一キャラ編集は利用できます。");
      return;
    }
    // All new-catalog writers in the UI take the same origin-scoped Web Lock.
    // An old editor callback also checks the selection generation before write.
    void navigator.locks.request(CHARACTER_DRAFT_CATALOG_KEY,
      { mode: "exclusive", signal: abort.signal }, async () => {
        if (disposed) return;
        try {
          const loaded = readCharacterDraftCatalog(localStorage);
          ownsLock.current = true;
          snapshotRef.current = loaded;
          setSnapshot(loaded);
          setAccess("ready");
          await new Promise<void>((resolve) => { release = resolve; });
        } catch (failure) {
          if (!disposed) {
            setError("キャラ別保存を開けません：" + message(failure));
            setAccess("unavailable");
          }
        } finally {
          ownsLock.current = false;
        }
      }).catch((failure: unknown) => {
        if (!disposed) {
          setError("キャラ別保存の編集ロックを取得できません：" + message(failure));
          setAccess("unavailable");
        }
      });
    return () => {
      disposed = true;
      ownsLock.current = false;
      abort.abort();
      release?.();
    };
  }, []);

  function current(): CatalogSnapshot {
    const value = snapshotRef.current;
    if (!ownsLock.current || !value) throw new Error("キャラ別保存の編集ロックがありません");
    if (localStorage.getItem(CHARACTER_DRAFT_CATALOG_KEY) !== value.raw) {
      throw new Error("キャラ別保存が外部で更新されました。再読み込みしてください");
    }
    return value;
  }

  function commit(next: CharacterDraftCatalog) {
    const previous = current();
    const updated = commitCharacterDraftCatalog(localStorage, previous.raw, next);
    if (previous.catalog.selectedId !== updated.catalog.selectedId) {
      generation.current++;
      // Do not reuse a detail URL belonging to the former character.
      const url = new URL(location.href);
      url.searchParams.delete("preset");
      history.replaceState(null, "", url.pathname + url.search + url.hash);
    }
    snapshotRef.current = updated;
    setSnapshot(updated);
    setError("");
  }

  function change(action: (catalog: CharacterDraftCatalog) => CharacterDraftCatalog): boolean {
    try {
      commit(action(current().catalog));
      return true;
    } catch (failure) {
      setError(message(failure));
      return false;
    }
  }

  const selected = snapshot?.catalog.groups.find((group) => group.id === snapshot.catalog.selectedId);
  const scope = selected?.id;
  const scopeGeneration = generation.current;
  function scopedSnapshot() {
    const value = current();
    if (!scope || scopeGeneration !== generation.current || value.catalog.selectedId !== scope) {
      throw new Error("編集中のキャラが切り替わりました。古い編集結果は反映しません");
    }
    const group = value.catalog.groups.find((entry) => entry.id === scope);
    if (!group) throw new Error("キャラが見つかりません");
    return { value, group };
  }
  const draftStore: PresetDraftStore | undefined = scope ? {
    read: () => scopedSnapshot().group.draft,
    write: (draft) => {
      const { value } = scopedSnapshot();
      commit(updateCharacterDraftGroup(value.catalog, scope, draft));
    },
  } : undefined;

  function confirmDiscardPendingName(): boolean {
    if (!form) return true;
    const committedName = form === "rename" ? selected?.name ?? "" : "";
    return name === committedName ||
      window.confirm("未確定のキャラ名を破棄して操作を続けますか？");
  }

  function startForm(mode: "add" | "copy" | "rename") {
    if (form === mode || !confirmDiscardPendingName()) return;
    setName(mode === "rename" ? selected?.name ?? "" : "");
    setForm(mode);
    setError("");
  }

  function switchGroup(id: string | null) {
    if (snapshot?.catalog.selectedId === id || !confirmDiscardPendingName()) return;
    if (change((catalog) => selectCharacterDraftGroup(catalog, id))) {
      setName("");
      setForm(null);
    }
  }

  function submit() {
    const ok = change((catalog) => {
      if (form === "rename" && scope) return renameCharacterDraftGroup(catalog, scope, name);
      if (form !== "add" && form !== "copy") throw new Error("キャラ追加操作が不正です");
      const copied = form === "copy" ? readPresetDraft() : null;
      if (form === "copy" && !copied) throw new Error("コピーする従来のプリセットがありません");
      return addCharacterDraftGroup(catalog, crypto.randomUUID(), name, copied);
    });
    if (ok) { setName(""); setForm(null); }
  }

  return <>
    <section className="panel character-preset-groups" aria-label="キャラクター切替">
      <div className="panel-heading">
        <h2>キャラクター</h2>
        <div className="input-row">
          <button type="button" className="secondary" disabled={access !== "ready"}
            onClick={() => startForm("add")}>＋ キャラ追加</button>
          {!scope && <button type="button" className="secondary" disabled={access !== "ready"}
            onClick={() => startForm("copy")}>従来のプリセットをキャラ登録</button>}
          {scope && <button type="button" className="secondary" disabled={access !== "ready"}
            onClick={() => startForm("rename")}>キャラ名変更</button>}
        </div>
      </div>
      {access === "loading" && <p className="hint">キャラ別設定の編集ロックを確認中です。別タブで編集中の場合は、そのタブを閉じてください。</p>}
      {snapshot && <div className="input-row" role="group" aria-label="編集するキャラ">
        <button type="button" aria-pressed={!scope}
          onClick={() => switchGroup(null)}>従来の単一キャラ</button>
        {snapshot.catalog.groups.map((group) => <button type="button" key={group.id}
          aria-pressed={group.id === scope}
          onClick={() => switchGroup(group.id)}>{group.name}</button>)}
      </div>}
      {form && <form className="input-row" onSubmit={(event) => { event.preventDefault(); submit(); }}>
        <label>キャラ名
          <input aria-label="キャラ管理の名前" value={name}
            onChange={(event) => setName(event.target.value)} required />
        </label>
        <button type="submit" disabled={!name.trim()}>確定</button>
        <button type="button" className="secondary" onClick={() => setForm(null)}>キャンセル</button>
      </form>}
      {error && <p role="alert" className="hint warning">{error}</p>}
      {access !== "loading" && (!scope
        ? <p className="hint">従来の「セリフ」画面用の単一キャラです。複数キャラを編集する場合はキャラを追加し、別々にPSDを読み込んでください。</p>
        : <p className="hint">{selected?.name} のプリセットを編集中。別キャラの設定は変更しません。</p>)}
    </section>
    {access !== "loading" && <PresetWorkspace key={scope ? "character:" + scope : "legacy"}
      utterances={scope ? noUtterances : props.utterances}
      isWavRegistrationPending={scope ? noPendingWavs : props.isWavRegistrationPending}
      draftStore={draftStore} />}
  </>;
}
