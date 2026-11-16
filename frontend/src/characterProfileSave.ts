/** Compatibility wrapper for the existing character-settings Save UI. */
import { saveJsonFile, type JsonSaveResult } from "./browserJsonSave";

export type CharacterProfileSaveResult = JsonSaveResult;

export function saveCharacterProfileFile(json: string): Promise<CharacterProfileSaveResult> {
  return saveJsonFile(json, "tachie-character-profile",
    "tachie-character.json", "キャラクター設定JSON");
}
