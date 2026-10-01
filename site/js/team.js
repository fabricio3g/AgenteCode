// The Bots section: Desktop's own animated faces (js/faces.js, bundled from
// the app) acting out a small handoff loop, the way they do in the app.

import { mountFace } from "./faces.js";

// Scripted like real activity: a request, a handoff, the work, the answer.
const SCRIPT = [
  { who: "colina", state: "thinking", event: "read", line: "@colina is reading your request" },
  { who: "colina", event: "done", line: "@colina → @scout: find three sources" },
  { who: "scout", state: "working", event: "search", line: "@scout is searching" },
  { who: "scout", event: "done", line: "@scout → @colina: replied" },
  { who: "quill", state: "working", event: "write", line: "@quill is drafting the brief" },
  { who: "quill", event: "done", line: "@quill finished the draft" },
  { who: "rook", state: "working", event: "run", line: "@rook is running the tests" },
  { who: "rook", event: "done", line: "@rook: all green" },
  { who: "juniper", state: "thinking", event: "read", line: "@juniper scheduled Friday’s review" },
  { who: "juniper", event: "done", line: "" },
];
const STEP_MS = 2200;

export function initTeam() {
  const hosts = [...document.querySelectorAll(".team .bot-face")];
  if (!hosts.length) return;
  const faces = new Map();
  for (const host of hosts) {
    const size = Math.round(host.getBoundingClientRect().width) || 88;
    faces.set(host.dataset.face, mountFace(host, { key: host.dataset.face, tint: host.dataset.tint, size }));
    // A touch makes a face react, as hovering a bot does in the app.
    host.parentElement.addEventListener("pointerenter", () => faces.get(host.dataset.face)?.react("done"));
  }

  const line = document.getElementById("team-line");
  let i = 0, timer = 0;
  function step() {
    const s = SCRIPT[i % SCRIPT.length];
    const face = faces.get(s.who);
    if (s.state) face.setState(s.state);
    face.react(s.event);
    if (s.event === "done") setTimeout(() => face.setState("idle"), 1400);
    if (line) {
      line.style.opacity = "0";
      setTimeout(() => {
        line.innerHTML = s.line ? s.line.replace(/@\w+/g, (h) => `<span class="who">${h}</span>`) : "&nbsp;";
        line.style.opacity = "1";
      }, 180);
    }
    i++;
  }

  const reduce = matchMedia("(prefers-reduced-motion: reduce)");
  new IntersectionObserver(([e]) => {
    clearInterval(timer);
    if (e.isIntersecting && !reduce.matches) { step(); timer = setInterval(step, STEP_MS); }
  }, { threshold: 0.35 }).observe(document.querySelector(".team"));
}
