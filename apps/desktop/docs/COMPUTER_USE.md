# Computer use in Home and Code

Windows support uses the same computer, mouse and keyboard as the user. Ask the agent to perform a desktop task with an image-capable model. A per-task system dialog asks for permission before capture or input begins.

While controlling, Agente shows a subtle click-through cover over every display and a floating top bar with the current action, elapsed time, Take over and End. It changes the real system arrow cursor to an ink pointer with an ember badge. It does not draw a second desktop mouse. Escape stops native input, stops screen observations, restores the configured cursor scheme and cancels the turn. Resume is explicit and starts a continuation with a fresh observation. End dismisses the overlay.

The monitor button in Home/Code opens session controls. In an idle chat it prepares a computer-task prompt; it never silently grants input permission. Native permission remains required in auto mode. Only one chat can control the desktop. Subagents cannot obtain that capability.

Screenshots are observations, not a video recording. Observations sent to the model use the existing attachment path and may remain with the chat. Overlay windows are excluded from capture on supported Windows versions. A display selection is not a security sandbox; shortcuts and app operations can affect the rest of the computer.

Development: `cargo build -p agente-computer` builds the helper. `npm run dev:agente` and `npm run build:agente` also build it; release packaging copies it into resources/bin. The system-cursor bitmap lives in `crates/agente-computer/src/cursor.bin`; the matching browser cursor source is `shared/agent-pointer.ts`. Browser use temporarily applies the style to the real page cursor, retaining only a click ring as feedback.

The native helper uses physical-Escape detection, generation-tagged input hooks, bounded actions and a three-second owner heartbeat. Cleanup releases held keys/buttons and restores the cursor. Higher-integrity/secure Windows dialogs require takeover. macOS and Linux input backends are not included.

Design references: [Figma cursors](https://www.figma.com/blog/april-fun-day-cursors/) for recognizable actor presence and [Carbon progress guidance](https://www.carbondesignsystem.com/building-blocks/core/components/progress-bar/guidelines) for status without invented percentages. The implementation keeps Agente's subtle surfaces and ember identity.
