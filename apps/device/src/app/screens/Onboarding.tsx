import { useState } from "react";
import { Bot } from "../../bot/Bot";
import { LAYER, useControls } from "../../input/controls";
import { Ico } from "../ui";

const STEPS = [
  {
    label: "01 / DUMP",
    title: "Say what is on your mind.",
    detail: "Hold the mic button and talk. Your words become a Note first, so nothing gets lost.",
    control: "MIC BUTTON",
    instruction: "Hold to speak · Release to save",
  },
  {
    label: "02 / CHOOSE",
    title: "Turn a Note into work.",
    detail: "The Device suggests tasks from your Notes. Turn the in-app wheel to browse. Press A to choose.",
    control: "IN-APP WHEEL",
    instruction: "Turn to browse · A to choose",
  },
  {
    label: "03 / APPROVE",
    title: "You make the final call.",
    detail: "An action that sends, deletes, pays, or leaves your machines stops for you. Press the push bar to approve it.",
    control: "PUSH BAR",
    instruction: "Press to approve a risky action",
  },
] as const;

export function Onboarding({ onDone }: { onDone: () => void }) {
  const [index, setIndex] = useState(0);
  const current = STEPS[index];
  const last = index === STEPS.length - 1;

  useControls(e => {
    if (e.c === "a") {
      if (last) onDone();
      else setIndex(i => i + 1);
      return true;
    }
    if (e.c === "b") {
      if (index === 0) onDone();
      else setIndex(i => i - 1);
      return true;
    }
    // The guide owns the controls until it closes. No action can start behind it.
    return true;
  }, { a: last ? "Start" : "Next", b: index === 0 ? "Skip" : "Back" }, true, LAYER.sheet);

  return <div className="scr onboarding" aria-label="First-run guide">
    <div className="onboarding-copy" key={index}>
      <span className="label onboarding-step-label">{current.label}</span>
      <h1 className="say">{current.title}</h1>
      <p className="onboarding-detail">{current.detail}</p>
      <div className="onboarding-control">
        <span className="onboarding-control-name">{current.control}</span>
        <span className="mute">{current.instruction}</span>
      </div>
    </div>

    <div className={`onboarding-visual onboarding-visual-${index}`} aria-hidden="true">
      {index === 0 && <>
        <Bot size={152} seed={3} state="idle" fps={20} />
        <span className="onboarding-visual-mark onboarding-mic">{Ico.mic(28)}</span>
      </>}
      {index === 1 && <>
        <div className="onboarding-note"><span>NOTE</span><i /><i /><i /></div>
        <span className="onboarding-visual-arrow">{Ico.arrow}</span>
        <div className="onboarding-task">{Ico.tasks}<span>TASK</span></div>
      </>}
      {index === 2 && <>
        <span className="onboarding-approval-ring"><Bot size={115} seed={3} state="warn" fps={20} /></span>
        <span className="onboarding-push-mark" />
      </>}
    </div>

    <div className="onboarding-footer" aria-label={`Step ${index + 1} of ${STEPS.length}`}>
      <div className="onboarding-progress">{STEPS.map((_, step) => <i key={step} className={step === index ? "active" : ""} />)}</div>
      <span className="mute">{index + 1} / {STEPS.length}</span>
    </div>
  </div>;
}
