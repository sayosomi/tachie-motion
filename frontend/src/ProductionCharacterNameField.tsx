import { useEffect, useState } from "react";

type Props = {
  characterId: string;
  name: string;
  disabled: boolean;
  /** Only publish a draft when the complete project passes validation. */
  onCommit: (nextName: string) => boolean;
};

/** Editing text is separate from the validated name stored in the v5 project. */
export default function ProductionCharacterNameField({
  characterId, name, disabled, onCommit,
}: Props) {
  const [draft, setDraft] = useState(name);

  // An externally replaced project may update the same stable character ID.
  useEffect(() => { setDraft(name); }, [name]);

  function commit() {
    if (draft === name) return;
    // Restore the canonical value if validation failed or editing is locked.
    if (!onCommit(draft)) setDraft(name);
  }

  return <input aria-label={"キャラ名: " + characterId}
    value={draft} disabled={disabled}
    onChange={(event) => setDraft(event.target.value)}
    onBlur={commit} />;
}
