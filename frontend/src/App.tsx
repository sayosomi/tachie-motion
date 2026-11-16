import { useState } from "react";
import PresetWorkspace from "./PresetWorkspace";
import UtteranceWorkspace from "./UtteranceWorkspace";

export default function App() {
  const [screen, setScreen] = useState<"presets" | "speech">("presets");
  const [speechVisited, setSpeechVisited] = useState(false);
  const [projectBusy, setProjectBusy] = useState(false);

  return <>
    <nav className="app-mode-tabs" aria-label="画面切り替え">
      <button type="button" disabled={projectBusy} aria-pressed={screen === "presets"}
        onClick={() => setScreen("presets")}>プリセット</button>
      <button type="button" disabled={projectBusy} aria-pressed={screen === "speech"}
        onClick={() => {
          setSpeechVisited(true);
          setScreen("speech");
        }}>セリフ</button>
    </nav>
    {screen === "presets" && <PresetWorkspace />}
    {speechVisited && <div hidden={screen !== "speech"}>
      <UtteranceWorkspace active={screen === "speech"}
        onProjectBusyChange={setProjectBusy} />
    </div>}
  </>;
}
