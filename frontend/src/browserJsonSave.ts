/** Browser-native JSON Save dialog. Never silently fall back to an automatic download. */
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
export type JsonSaveResult = { status: "saved"; filename: string } | { status: "cancelled" };

export async function saveJsonFile(json: string, id: string,
  suggestedName: string, description: string): Promise<JsonSaveResult> {
  const browser = window as SavePickerWindow;
  if (!browser.showSaveFilePicker) {
    throw new Error("このブラウザでは保存先を選ぶ標準ダイアログを利用できません。デスクトップ版ChromeまたはEdgeで開いてください。");
  }
  let handle: SaveHandle;
  try {
    // Call within the original click's user activation, without awaiting first.
    handle = await browser.showSaveFilePicker({
      id, suggestedName,
      types: [{ description, accept: { "application/json": [".json"] } }],
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return { status: "cancelled" };
    }
    throw error;
  }
  let writer: SaveWriter | undefined;
  try {
    writer = await handle.createWritable();
    await writer.write(json);
    await writer.close();
  } catch (error) {
    if (writer) {
      try { await writer.abort(); } catch { /* Retain original failure. */ }
    }
    throw error;
  }
  return { status: "saved", filename: handle.name };
}
