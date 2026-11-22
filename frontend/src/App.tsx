import { useRef, useState } from "react";
import PresetWorkspace from "./PresetWorkspace";
import UtteranceWorkspace from "./UtteranceWorkspace";
import type { UtteranceItem } from "./utteranceItems";
import IdleMotionWorkspace from "./IdleMotionWorkspace";
import { hasRestorableIdleExport } from "./useExportProgress";

export default function App() {
  const [restoringIdle] = useState(hasRestorableIdleExport);
  const [screen, setScreen] = useState<"presets" | "speech" | "idle">(
    restoringIdle ? "idle" : "presets");
  const [speechVisited, setSpeechVisited] = useState(false);
  const [idleVisited, setIdleVisited] = useState(restoringIdle);
  const [projectBusy, setProjectBusy] = useState(false);
  const [speechBusy, setSpeechBusy] = useState(false);
  const [idleBusy, setIdleBusy] = useState(restoringIdle);
  const navigationLocked = projectBusy || speechBusy || idleBusy;
  // Keep the WAV references alive while the preset screen is mounted so a
  // preset cannot be deleted out from under an existing utterance or point.
  const [utterances, setUtterances] = useState<UtteranceItem[]>([]);
  // WAV inspection may finish after switching screens. Keep this guard
  // synchronous, independent of React's render/commit scheduling.
  const pendingWavRegistrations = useRef(0);
  const changePendingWavRegistrations = (delta: number) => {
    pendingWavRegistrations.current += delta;
  };

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
    {screen === "presets" && <PresetWorkspace utterances={utterances}
      isWavRegistrationPending={() => pendingWavRegistrations.current > 0} />}
    {speechVisited && <div hidden={screen !== "speech"}>
      <UtteranceWorkspace active={screen === "speech"}
        items={utterances} setItems={setUtterances}
        onWavRegistrationPendingChange={changePendingWavRegistrations}
        onProjectBusyChange={setProjectBusy} onExportBusyChange={setSpeechBusy} />
    </div>}
    {idleVisited && <div hidden={screen !== "idle"}>
      <IdleMotionWorkspace active={screen === "idle"} onBusyChange={setIdleBusy} />
    </div>}
  </>;
}
