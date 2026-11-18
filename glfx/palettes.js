// Shared palettes. The lab and the landing page read the same tokens, so a
// colour only ever has to be corrected in one place.

// Two palettes, same keys, so one shader serves both.
// Agente: brand tokens plus a naturalist ramp, paper and ink like an old science
// plate, sea and kelp for the ocean studies, orange kept as the hand-tint.
const AGENTE = {
  light: { bg: "#ffffff", accent: "#e76d1f", hi: "#ffb27a", ink: "#0d0d0d", faint: "#f8d8c2",
    paper: "#f4eee2", sepia: "#2a1f17", sea: "#2f6f7a", abyss: "#d7e4e0", kelp: "#5f7d43", ochre: "#b97a2c",
    ivory: "#f7f2e8", clay: "#e76d1f", kraft: "#b98a5a", sage: "#6d7f57",
    deep: "#dfe7f2", cyan: "#0f8ea3", plum: "#6a4fc4", poppy: "#dc4a2e" },
  dark: { bg: "#161616", accent: "#e8793a", hi: "#ffbe98", ink: "#ececec", faint: "#3a2418",
    paper: "#15130f", sepia: "#e6dbc4", sea: "#1f5560", abyss: "#08161a", kelp: "#4f6b3a", ochre: "#c98a3c",
    ivory: "#1b1815", clay: "#e8793a", kraft: "#a97c50", sage: "#6f7f5a",
    deep: "#101a2e", cyan: "#3fc6d6", plum: "#8a63d8", poppy: "#f2593d" },
};

// Claude: Anthropic's production swatches — ivory #FAF9F5 / #F0EEE6, clay
// #D97757, slate #141413, plus sky, olive and kraft from the swatch list. Every
// neutral is warm (R > G > B); clay stays an accent, never a full-bleed field.
const CLAUDE = {
  // The complement is drawn from their own swatches: sky #6A9BCC and cloud
  // #C5D3E0 against clay, mineral #629987 and plum #827DBD as the split pair.
  light: { bg: "#faf9f5", accent: "#d97757", hi: "#ebc9b7", ink: "#141413", faint: "#e8e6dc",
    paper: "#f5f4ed", sepia: "#3d3d3a", sea: "#6a9bcc", abyss: "#dedcd1", kelp: "#788c5d", ochre: "#d4a27f",
    ivory: "#faf9f5", clay: "#d97757", kraft: "#d4a27f", sage: "#788c5d",
    deep: "#c5d3e0", cyan: "#4a7f70", plum: "#6f6ab0", poppy: "#c94f4f" },
  dark: { bg: "#141413", accent: "#d97757", hi: "#ebc9b7", ink: "#faf9f5", faint: "#262624",
    paper: "#1a1918", sepia: "#e8e6dc", sea: "#4f7ba6", abyss: "#1f1e1d", kelp: "#8ea06c", ochre: "#c9956c",
    ivory: "#1a1918", clay: "#d97757", kraft: "#c9956c", sage: "#8ea06c",
    deep: "#33506e", cyan: "#629987", plum: "#827dbd", poppy: "#de6262" },
};

const BY_NAME = { agente: AGENTE, claude: CLAUDE };

/** The palette for a brand and a theme: `paletteFor("agente", "dark")`. */
export function paletteFor(name, theme) {
  return (BY_NAME[name] || AGENTE)[theme === "light" ? "light" : "dark"];
}
