// Hero install card: pick Desktop app or CLI, then an OS. Desktop shows the
// release installers; the CLI shows a copyable command. File names follow
// docs/RELEASING.md (release.yml and desktop-release.yml).

import { placeThumb, copyText } from "./ui.js";

const DL = "https://github.com/fabricio3g/AgenteCode/releases/latest/download/";
const REPO = "https://github.com/fabricio3g/AgenteCode";

const DESKTOP = {
  windows: [{ file: "Agente-win-x64.exe", meta: "Windows x64 installer" }],
  linux: [
    { file: "Agente-linux-x86_64.AppImage", meta: "Linux x64 · runs on most distributions" },
    { file: "Agente-linux-amd64.deb", meta: "Debian and Ubuntu" },
  ],
  arm: null, // not built for arm64
  macos: null, // no macOS installer yet
};

const CLI = {
  linux: { prompt: "$", cmd: `curl -fL -o ~/.local/bin/agente ${DL}agente-linux-x86_64 && chmod +x ~/.local/bin/agente` },
  arm: { prompt: "$", cmd: `curl -fL -o ~/.local/bin/agente ${DL}agente-linux-arm64 && chmod +x ~/.local/bin/agente` },
  windows: { prompt: ">", cmd: `iwr ${DL}agente-windows-x86_64.exe -OutFile agente.exe` },
  macos: { prompt: "$", cmd: `git clone ${REPO}.git && cd AgenteCode && cargo build --release --bin agente`, note: "No macOS binary yet, so this builds it from source." },
};

const ICON = {
  download: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m-5-5 5 5 5-5M5 21h14"/></svg>',
  copy: '<svg class="i-copy" viewBox="0 0 24 24" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>',
  check: '<svg class="i-check" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>',
};

const esc = (t) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function detectOs() {
  const ua = navigator.userAgent;
  if (/Windows/i.test(ua)) return "windows";
  if (/Mac OS X|Macintosh/i.test(ua) && !/iPhone|iPad/i.test(ua)) return "macos";
  if (/aarch64|arm64/i.test(ua)) return "arm";
  return "linux";
}

function desktopHtml(os) {
  const files = DESKTOP[os];
  if (!files) {
    const why = os === "arm" ? "The desktop app isn’t built for ARM yet." : "There’s no macOS installer yet.";
    return `<p class="install-empty">${why} Use the <button type="button" class="link" data-switch="cli">CLI</button>, or build Desktop from source with the <a href="${REPO}/blob/main/apps/desktop/README.md">Desktop guide</a>.</p>`;
  }
  return `<div class="dl-list">${files.map((f) => `
    <a class="dl-row" href="${DL}${f.file}">
      <span class="dl-name">${f.file}</span><span class="dl-meta">${f.meta}</span>
      <span class="dl-go">${ICON.download}Download</span>
    </a>`).join("")}</div>`;
}

function cliHtml(os) {
  const c = CLI[os];
  return `<div class="cmd-row">
      <pre><code><span class="c-p">${c.prompt}</span> ${esc(c.cmd)}</code></pre>
      <button class="copy-btn" type="button" aria-label="Copy install command">${ICON.copy}${ICON.check}<span class="copy-label">Copy</span></button>
    </div>
    ${c.note ? `<p class="install-foot">${c.note}</p>` : `<p class="install-foot">Then run <code>agente</code> in a project folder.</p>`}`;
}

export function initInstall() {
  const card = document.getElementById("install");
  if (!card) return;
  const body = document.getElementById("install-body");
  const groups = Object.fromEntries(
    [...card.querySelectorAll("[data-pick]")].map((g) => [g.dataset.pick, g]),
  );
  const state = { product: "desktop", os: detectOs() };
  let first = true;

  const thumbs = () => {
    for (const [key, group] of Object.entries(groups)) {
      placeThumb(group, group.querySelector(`[data-value="${state[key]}"]`));
    }
  };

  function render() {
    for (const [key, group] of Object.entries(groups)) {
      const buttons = [...group.querySelectorAll("[role=radio]")];
      buttons.forEach((b) => {
        const on = b.dataset.value === state[key];
        b.setAttribute("aria-checked", String(on));
        b.tabIndex = on ? 0 : -1;
        // Mark OSes the chosen product doesn't ship for.
        if (key === "os") b.classList.toggle("is-unavailable", state.product === "desktop" && !DESKTOP[b.dataset.value]);
      });
    }
    thumbs();
    const html = state.product === "desktop" ? desktopHtml(state.os) : cliHtml(state.os);
    if (first) { body.innerHTML = html; first = false; return; }
    body.classList.remove("swap");
    void body.offsetWidth; // restart the swap animation
    body.innerHTML = html;
    body.classList.add("swap");
  }

  for (const [key, group] of Object.entries(groups)) {
    const buttons = [...group.querySelectorAll("[role=radio]")];
    buttons.forEach((b, i) => {
      b.addEventListener("click", () => { state[key] = b.dataset.value; render(); });
      b.addEventListener("keydown", (e) => {
        const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
        if (!step) return;
        e.preventDefault();
        const next = buttons[(i + step + buttons.length) % buttons.length];
        state[key] = next.dataset.value;
        render();
        next.focus();
      });
    });
    new ResizeObserver(thumbs).observe(group);
    group.classList.add("ready");
  }

  body.addEventListener("click", (e) => {
    const copy = e.target.closest(".copy-btn");
    if (copy) copyText(copy, CLI[state.os].cmd);
    const sw = e.target.closest("[data-switch]");
    if (sw) { state.product = sw.dataset.switch; render(); }
  });

  document.fonts?.ready.then(thumbs);
  render();
}
