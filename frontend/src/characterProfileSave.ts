/** Save an explicit character profile through the browser's native Save dialog. */
type SaveWriter = {
  write(data: string): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
};
type SaveHandle = {
  name: string;
  createWritable(): Promise<SaveWriter>;
};
type SavePickerWindow = Window & {
  showSaveFilePicker?: (options: {
    id: string;
    suggestedName: string;
    types: { description: string; accept: Record<string, string[]> }[];
  }) => Promise<SaveHandle>;
};

export type CharacterProfileSaveResult =
  | { status: "saved"; filename: string }
  | { status: "cancelled" };

export async function saveCharacterProfileFile(json: string): Promise<CharacterProfileSaveResult> {
  const browser = window as SavePickerWindow;
  if (!browser.showSaveFilePicker) {
    throw new Error("このブラウザでは保存先を選ぶ標準ダイアログを利用できません。デスクトップ版ChromeまたはEdgeで開いてください。");
  }

  let handle: SaveHandle;
  try {
    // Must run directly in the click handler's user-activation context.
    handle = await browser.showSaveFilePicker({
      id: "tachie-character-profile",
      suggestedName: "tachie-character.json",
      types: [{ description: "キャラクター設定JSON", accept: { "application/json": [".json"] } }],
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return { status: "cancelled" };
    }
    throw error;
  }

  let writable: SaveWriter | undefined;
  try {
    writable = await handle.createWritable();
    await writable.write(json);
    await writable.close();
  } catch (error) {
    if (writable) {
      try { await writable.abort(); } catch { /* Keep the original failure. */ }
    }
    throw error;
  }
  return { status: "saved", filename: handle.name };
}
