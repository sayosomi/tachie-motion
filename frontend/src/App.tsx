import { useState } from "react";
import PresetWorkspace from "./PresetWorkspace";
import UtteranceWorkspace from "./UtteranceWorkspace";
import IdleMotionWorkspace from "./IdleMotionWorkspace";

export default function App() {
  const [screen, setScreen] = useState<"presets" | "speech" | "idle">("presets");
  const [speechVisited, setSpeechVisited] = useState(false);
  const [idleVisited, setIdleVisited] = useState(false);
  const [projectBusy, setProjectBusy] = useState(false);
  const [speechBusy, setSpeechBusy] = useState(false);
  const [idleBusy, setIdleBusy] = useState(false);
  const navigationLocked = projectBusy || speechBusy || idleBusy;

  return <>
    <nav className="app-mode-tabs" aria-label="画面切り替え">
      <button type="button" disabled={navigationLocked} aria-pressed={screen === "presets"}
        onClick={() => setScreen("presets")}>プリセット</button>
      <button type="button" disabled={navigationLocked} aria-pressed={screen === "speech"}
        onClick={() => {
          setSpeechVisited(true);
          setScreen("speech");
        }}>セリフ</button>
      <button type="button" disabled={navigationLocked} aria-pressed={screen === "idle"}
        onClick={() => {
          setIdleVisited(true);
          setScreen("idle");
        }}>待機MOV</button>
    </nav>
    {screen === "presets" && <PresetWorkspace />}
    {speechVisited && <div hidden={screen !== "speech"}>
      <UtteranceWorkspace active={screen === "speech"}
        onProjectBusyChange={setProjectBusy} onExportBusyChange={setSpeechBusy} />
    </div>}
    {idleVisited && <div hidden={screen !== "idle"}>
      <IdleMotionWorkspace active={screen === "idle"} onBusyChange={setIdleBusy} />
    </div>}
  </>;
}
