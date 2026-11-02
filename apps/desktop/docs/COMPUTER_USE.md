# Computer use in Home and Code

Windows support uses the same computer, mouse and keyboard as the user. Ask the agent to perform a desktop task with an image-capable model. A per-task system dialog asks for permission before capture or input begins.

While controlling, Agente shows a subtle click-through cover over every display and a floating top bar with the current action, elapsed time, Take over and End. It changes the real system arrow cursor to an ink pointer with an ember badge. It does not draw a second desktop mouse. Escape stops native input, stops screen observations, restores the configured cursor scheme and cancels the turn. Resume is explicit and starts a continuation with a fresh observation. End dismisses the overlay.

The monitor button in Home/Code opens session controls. In an idle chat it prepares a computer-task prompt; it never silently grants input permission. Native permission remains required in auto mode. Only one chat can control the desktop. Subagents cannot obtain that capability.

Screenshots are observations, not a video recording. Observations sent to the model use the existing attachment path and may remain with the chat. Overlay windows are excluded from capture on supported Windows versions. A display selection is not a security sandbox; shortcuts and app operations can affect the rest of the computer.

Development: `cargo build -p agente-computer` builds the helper. `npm run dev:agente` and `npm run build:agente` also build it; release packaging copies it into resources/bin. The system-cursor bitmap lives in `crates/agente-computer/src/cursor.bin`; the matching browser cursor source is `shared/agent-pointer.ts`. Browser use temporarily applies the style to the real page cursor, retaining only a click ring as feedback.

The native helper uses physical-Escape detection, generation-tagged input hooks, bounded actions and a three-second owner heartbeat. Cleanup releases held keys/buttons and restores the cursor. Higher-integrity/secure Windows dialogs require takeover. macOS and Linux input backends are not included.

Long tasks: Home computer-capable turns default to up to 300 iterations, 1,000 tool calls and one hour; explicit Home budget overrides remain in effect. Code receives an extended iteration allowance once computer control is actually granted. Desktop inactivity expires after ten minutes without an observation or action, rather than two; native heartbeat loss and Escape still revoke immediately. The agent must work through the request and verify its outcome before declaring completion.

Successful computer calls reset their repetition count: successive `computer_observe({})` calls are fresh screenshots, not a stuck loop. Repeated failures still trigger guidance and a six-repeat limit, but that limit removes the failing computer tool from the current turn instead of terminating the entire agent. If observing is blocked, desktop actions are blocked too. Other tools and `computer_finish` remain available. Ordinary tool-loop protection is unchanged. Runtime changes require rebuilding/restarting the daemon, not just reloading the renderer.

Design references: [Figma cursors](https://www.figma.com/blog/april-fun-day-cursors/) for recognizable actor presence and [Carbon progress guidance](https://www.carbondesignsystem.com/building-blocks/core/components/progress-bar/guidelines) for status without invented percentages. The implementation keeps Agente's subtle surfaces and ember identity.
