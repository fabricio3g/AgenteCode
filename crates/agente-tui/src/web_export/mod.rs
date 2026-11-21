//! Web export and visual inspection module.
//!
//! Provides high-fidelity serialization of Ratatui [`ratatui::buffer::Buffer`]s
//! to pixel-perfect HTML, CSS, and JSON, with built-in invariant checking
//! (theme holes, wide-glyph defects, control characters) and standalone
//! interactive visual gallery generation for browser testing.

pub(crate) mod theme;

use ratatui::buffer::Buffer;
use ratatui::style::{Color, Modifier};
use serde::{Deserialize, Serialize};

/// A contiguous run of styled cells on a single row (for compact HTML rendering).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StyledSpan {
    pub text: String,
    pub fg: String,
    pub bg: String,
    pub is_reset_bg: bool,
    pub bold: bool,
    pub italic: bool,
    pub underline: bool,
    pub dim: bool,
    pub reversed: bool,
    pub crossed_out: bool,
}

/// A single rendered frame with metadata and invariant diagnostics.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SerializedFrame {
    pub width: u16,
    pub height: u16,
    pub rows: Vec<Vec<StyledSpan>>,
    pub theme_holes: Vec<(u16, u16)>,
    pub violations: Vec<String>,
    pub raw_text: String,
}

/// Convert Ratatui [`Color`] to CSS color string (`#rrggbb` or `rgb(...)`).
pub fn color_to_css(color: Color, is_bg: bool) -> (String, bool) {
    match color {
        Color::Reset => {
            if is_bg {
                ("rgba(0, 0, 0, 0)".to_string(), true)
            } else {
                ("#e4e4e6".to_string(), false)
            }
        }
        Color::Rgb(r, g, b) => (format!("#{r:02x}{g:02x}{b:02x}"), false),
        Color::Black => ("#111114".to_string(), false),
        Color::Red => ("#cc6666".to_string(), false),
        Color::Green => ("#b5bd68".to_string(), false),
        Color::Yellow => ("#d9a13b".to_string(), false),
        Color::Blue => ("#61afef".to_string(), false),
        Color::Magenta => ("#c678dd".to_string(), false),
        Color::Cyan => ("#8abeb7".to_string(), false),
        Color::Gray => ("#9a9aa2".to_string(), false),
        Color::DarkGray => ("#5c5c64".to_string(), false),
        Color::LightRed => ("#e06c75".to_string(), false),
        Color::LightGreen => ("#98c379".to_string(), false),
        Color::LightYellow => ("#e5c07b".to_string(), false),
        Color::LightBlue => ("#5f87ff".to_string(), false),
        Color::LightMagenta => ("#d19a66".to_string(), false),
        Color::LightCyan => ("#56b6c2".to_string(), false),
        Color::White => ("#f8f8f2".to_string(), false),
        Color::Indexed(idx) => (indexed_color_to_hex(idx), false),
    }
}

/// Convert 256-color index to Hex color.
pub fn indexed_color_to_hex(idx: u8) -> String {
    match idx {
        0 => "#000000".to_string(),
        1 => "#800000".to_string(),
        2 => "#008000".to_string(),
        3 => "#808000".to_string(),
        4 => "#000080".to_string(),
        5 => "#800080".to_string(),
        6 => "#008080".to_string(),
        7 => "#c0c0c0".to_string(),
        8 => "#808080".to_string(),
        9 => "#ff0000".to_string(),
        10 => "#00ff00".to_string(),
        11 => "#ffff00".to_string(),
        12 => "#0000ff".to_string(),
        13 => "#ff00ff".to_string(),
        14 => "#00ffff".to_string(),
        15 => "#ffffff".to_string(),
        16..=231 => {
            let i = idx - 16;
            let r = (i / 36) * 51;
            let g = ((i % 36) / 6) * 51;
            let b = (i % 6) * 51;
            format!("#{r:02x}{g:02x}{b:02x}")
        }
        232..=255 => {
            let gray = 8 + (idx - 232) * 10;
            format!("#{gray:02x}{gray:02x}{gray:02x}")
        }
    }
}

/// Escape HTML special characters.
pub fn escape_html(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

/// Serialize a Ratatui [`Buffer`] into a structured [`SerializedFrame`].
pub fn serialize_buffer(buf: &Buffer) -> SerializedFrame {
    let width = buf.area.width;
    let height = buf.area.height;
    let mut rows = Vec::with_capacity(height as usize);
    let mut theme_holes = Vec::new();
    let mut violations = Vec::new();
    let mut raw_text = String::new();

    for y in 0..height {
        let mut row_spans: Vec<StyledSpan> = Vec::new();
        let mut current_span: Option<StyledSpan> = None;

        for x in 0..width {
            let cell = &buf[(x, y)];
            let sym = cell.symbol();
            raw_text.push_str(sym);

            // Invariant checks
            if sym.chars().any(|c| c.is_control()) {
                violations.push(format!("Control char at ({x},{y}): {sym:?}"));
            }
            if sym.is_empty() {
                let prev_wide =
                    x > 0 && crate::widgets::display_width(buf[(x - 1, y)].symbol()) > 1;
                if !prev_wide {
                    violations.push(format!("Empty (non-continuation) cell at ({x},{y})"));
                }
            }

            let (fg_css, _) = color_to_css(cell.fg, false);
            let (bg_css, is_reset_bg) = color_to_css(cell.bg, true);

            if is_reset_bg {
                theme_holes.push((x, y));
            }

            let bold = cell.modifier.contains(Modifier::BOLD);
            let italic = cell.modifier.contains(Modifier::ITALIC);
            let underline = cell.modifier.contains(Modifier::UNDERLINED);
            let dim = cell.modifier.contains(Modifier::DIM);
            let reversed = cell.modifier.contains(Modifier::REVERSED);
            let crossed_out = cell.modifier.contains(Modifier::CROSSED_OUT);

            // Actual displayed fg/bg with reversed modifier
            let (actual_fg, actual_bg) = if reversed {
                (bg_css.clone(), fg_css.clone())
            } else {
                (fg_css, bg_css)
            };

            let can_merge = current_span.as_ref().is_some_and(|s| {
                s.fg == actual_fg
                    && s.bg == actual_bg
                    && s.is_reset_bg == is_reset_bg
                    && s.bold == bold
                    && s.italic == italic
                    && s.underline == underline
                    && s.dim == dim
                    && s.crossed_out == crossed_out
            });

            if can_merge {
                if let Some(s) = current_span.as_mut() {
                    s.text.push_str(sym);
                }
            } else {
                if let Some(s) = current_span.take() {
                    row_spans.push(s);
                }
                current_span = Some(StyledSpan {
                    text: sym.to_string(),
                    fg: actual_fg,
                    bg: actual_bg,
                    is_reset_bg,
                    bold,
                    italic,
                    underline,
                    dim,
                    reversed,
                    crossed_out,
                });
            }
        }

        if let Some(s) = current_span.take() {
            row_spans.push(s);
        }
        rows.push(row_spans);
        raw_text.push('\n');
    }

    if !theme_holes.is_empty() {
        violations.push(format!(
            "{} cell(s) with Reset background (theme hole), first at ({},{})",
            theme_holes.len(),
            theme_holes[0].0,
            theme_holes[0].1
        ));
    }

    SerializedFrame {
        width,
        height,
        rows,
        theme_holes,
        violations,
        raw_text,
    }
}

/// Render a single [`SerializedFrame`] into HTML `<span>` elements.
pub fn frame_to_html_snippet(frame: &SerializedFrame) -> String {
    let mut html = String::new();
    for (y, row) in frame.rows.iter().enumerate() {
        html.push_str(&format!("<div class=\"tui-row\" data-y=\"{y}\">"));
        for span in row {
            let mut style_parts = Vec::new();
            if !span.fg.is_empty() {
                style_parts.push(format!("color:{};", span.fg));
            }
            if !span.bg.is_empty() && !span.is_reset_bg {
                style_parts.push(format!("background-color:{};", span.bg));
            }
            if span.bold {
                style_parts.push("font-weight:bold;".to_string());
            }
            if span.italic {
                style_parts.push("font-style:italic;".to_string());
            }
            if span.underline {
                style_parts.push("text-decoration:underline;".to_string());
            }
            if span.dim {
                style_parts.push("opacity:0.65;".to_string());
            }
            if span.crossed_out {
                style_parts.push("text-decoration:line-through;".to_string());
            }

            let style_attr = if style_parts.is_empty() {
                String::new()
            } else {
                format!(" style=\"{}\"", style_parts.join(""))
            };

            let hole_class = if span.is_reset_bg { " theme-hole" } else { "" };

            html.push_str(&format!(
                "<span class=\"tui-span{}\"{}>{}</span>",
                hole_class,
                style_attr,
                escape_html(&span.text)
            ));
        }
        html.push_str("</div>");
    }
    html
}

/// One gallery row: scenario name, terminal size, the frame, category, description.
#[cfg(test)]
pub type GalleryEntry = (
    &'static str,
    (u16, u16),
    SerializedFrame,
    &'static str,
    &'static str,
);

/// Generate a complete, standalone, zero-dependency interactive HTML Visual
/// Gallery page (written by the visual harness).
#[cfg(test)]
pub fn generate_visual_gallery_html(scenarios_data: &[GalleryEntry]) -> String {
    let scenarios_json = serde_json::to_string(
        &scenarios_data
            .iter()
            .map(|(name, (w, h), frame, cat, desc)| {
                serde_json::json!({
                    "name": name,
                    "width": w,
                    "height": h,
                    "category": cat,
                    "description": desc,
                    "theme_holes_count": frame.theme_holes.len(),
                    "violations": frame.violations,
                    "html": frame_to_html_snippet(frame),
                    "raw_text": frame.raw_text,
                })
            })
            .collect::<Vec<_>>(),
    )
    .unwrap_or_else(|_| "[]".to_string());

    let head = theme::studio_head(
        "Agente Code — Browser Visual Studio & Invariant Inspector",
        GALLERY_EXTRA_CSS,
    );

    format!(
        r##"{head}<body>

<div id="sidebar" class="studio-sidebar">
  <div class="studio-header">
    <h1>◈ Agente TUI Studio</h1>
    <p>Visual testing, invariant inspector & responsive suite</p>
    <div class="search-box">
      <input type="text" id="search-input" placeholder="Filter scenarios (e.g. chat, approval, session)...">
    </div>
  </div>
  <div class="scenario-list" id="scenario-list"></div>
</div>

<div id="main" class="studio-workspace">
  <div class="studio-toolbar">
    <div class="studio-toolbar-left">
      <div class="studio-pill-group" id="size-selector">
        <button class="studio-pill" data-size="120x40">120x40</button>
        <button class="studio-pill active" data-size="100x30">100x30</button>
        <button class="studio-pill" data-size="80x24">80x24</button>
        <button class="studio-pill" data-size="60x18">60x18</button>
        <button class="studio-pill" data-size="40x12">40x12</button>
      </div>
      <button class="studio-toggle" id="theme-holes-toggle">
        <span>🚨</span> Show Theme Holes
      </button>
    </div>
    <div class="studio-toolbar-right">
      <span id="current-scenario-label" style="font-size:12px; font-weight:600; color:var(--primary);"></span>
    </div>
  </div>

  <div id="viewport-stage" class="studio-stage">
    <div class="terminal-frame" id="terminal-container">
      <div class="terminal-titlebar">
        <div class="titlebar-dots">
          <div class="dot red"></div>
          <div class="dot yellow"></div>
          <div class="dot green"></div>
        </div>
        <div class="titlebar-title" id="frame-title">agente</div>
        <div class="titlebar-meta" id="frame-size-meta">100x30</div>
      </div>
      <div class="terminal-screen" id="terminal-screen"></div>
    </div>
  </div>

  <div id="diagnostics" class="studio-drawer">
    <div class="studio-drawer-header">
      <span>Invariant Diagnostics & Layout Verification</span>
      <span id="diag-summary"></span>
    </div>
    <div class="studio-drawer-body" id="diag-content"></div>
  </div>
</div>

<script>
  const scenarios = {scenarios_json};
  const requested = new URLSearchParams(window.location.search);
  let currentScenarioName = requested.get("scenario") || scenarios[0]?.name || "";
  let currentSize = requested.get("size") || "100x30";
  let showThemeHoles = false;

  const scenarioListEl = document.getElementById("scenario-list");
  const screenEl = document.getElementById("terminal-screen");
  const frameTitleEl = document.getElementById("frame-title");
  const frameSizeMetaEl = document.getElementById("frame-size-meta");
  const scenarioLabelEl = document.getElementById("current-scenario-label");
  const diagContentEl = document.getElementById("diag-content");
  const diagSummaryEl = document.getElementById("diag-summary");
  const searchInputEl = document.getElementById("search-input");
  const themeHolesToggleBtn = document.getElementById("theme-holes-toggle");

  function getUniqueScenarios() {{
    const map = new Map();
    scenarios.forEach((s) => {{
      if (!map.has(s.name)) {{
        map.set(s.name, s);
      }}
    }});
    return Array.from(map.values());
  }}

  function getCurrentScenario() {{
    const [w, h] = currentSize.split("x").map(Number);
    let match = scenarios.find(s => s.name === currentScenarioName && s.width === w && s.height === h);
    if (!match) {{
      match = scenarios.find(s => s.name === currentScenarioName) || scenarios[0];
    }}
    return match;
  }}

  function renderSidebar(filter = "") {{
    scenarioListEl.innerHTML = "";
    const lowerFilter = filter.toLowerCase();
    const unique = getUniqueScenarios();

    const categories = {{}};
    unique.forEach((s) => {{
      if (filter && !s.name.toLowerCase().includes(lowerFilter) && !s.description.toLowerCase().includes(lowerFilter)) {{
        return;
      }}
      if (!categories[s.category]) {{
        categories[s.category] = [];
      }}
      categories[s.category].push(s);
    }});

    for (const [catName, items] of Object.entries(categories)) {{
      const groupEl = document.createElement("div");
      groupEl.className = "category-group";

      const titleEl = document.createElement("div");
      titleEl.className = "category-title";
      titleEl.textContent = catName;
      groupEl.appendChild(titleEl);

      items.forEach((scenario) => {{
        const itemEl = document.createElement("div");
        const isActive = scenario.name === currentScenarioName;
        itemEl.className = `scenario-item ${{isActive ? "active" : ""}}`;
        itemEl.onclick = () => selectScenarioName(scenario.name);

        const hasViolations = scenario.violations.length > 0;
        itemEl.innerHTML = `
          <div class="scenario-item-header">
            <span class="scenario-name">${{scenario.name}}</span>
            <span class="badge ${{hasViolations ? "badge-violation" : "badge-pass"}}">
              ${{hasViolations ? scenario.violations.length + " err" : "✓ ok"}}
            </span>
          </div>
          <div class="scenario-desc">${{scenario.description || scenario.name}}</div>
        `;
        groupEl.appendChild(itemEl);
      }});

      scenarioListEl.appendChild(groupEl);
    }}
  }}

  function selectScenarioName(name) {{
    currentScenarioName = name;
    renderSidebar(searchInputEl.value);
    renderCurrentFrame();
  }}

  function renderCurrentFrame() {{
    const s = getCurrentScenario();
    if (!s) return;

    frameTitleEl.textContent = `agente — ${{s.name}}`;
    frameSizeMetaEl.textContent = `${{s.width}}x${{s.height}}`;
    scenarioLabelEl.textContent = `${{s.name}} (${{s.width}}x${{s.height}})`;

    screenEl.innerHTML = s.html;
    screenEl.classList.toggle("theme-hole-active", showThemeHoles);

    document.querySelectorAll("#size-selector .studio-pill").forEach(btn => {{
      btn.classList.toggle("active", btn.dataset.size === `${{s.width}}x${{s.height}}`);
    }});

    if (s.violations.length === 0) {{
      diagSummaryEl.innerHTML = `<span class="diag-ok">✓ All Invariants Passed (0 Violations)</span>`;
      diagContentEl.innerHTML = `<div class="diag-ok">✓ No theme holes (Color::Reset bleed), control characters, or wide-glyph continuation defects detected.</div>`;
    }} else {{
      diagSummaryEl.innerHTML = `<span class="diag-error">✗ ${{s.violations.length}} Violation(s) Found</span>`;
      diagContentEl.innerHTML = s.violations.map(v => `<div class="diag-error">✗ ${{v}}</div>`).join("");
    }}
  }}

  searchInputEl.addEventListener("input", (e) => {{
    renderSidebar(e.target.value);
  }});

  themeHolesToggleBtn.addEventListener("click", () => {{
    showThemeHoles = !showThemeHoles;
    themeHolesToggleBtn.classList.toggle("active", showThemeHoles);
    renderCurrentFrame();
  }});

  document.querySelectorAll("#size-selector .studio-pill").forEach(btn => {{
    btn.addEventListener("click", () => {{
      document.querySelectorAll("#size-selector .studio-pill").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      currentSize = btn.dataset.size;
      renderCurrentFrame();
    }});
  }});

  window.addEventListener("keydown", (e) => {{
    if (document.activeElement === searchInputEl) return;
    const unique = getUniqueScenarios();
    const curIdx = unique.findIndex(s => s.name === currentScenarioName);
    if (e.key === "ArrowDown") {{
      e.preventDefault();
      if (curIdx < unique.length - 1) selectScenarioName(unique[curIdx + 1].name);
    }} else if (e.key === "ArrowUp") {{
      e.preventDefault();
      if (curIdx > 0) selectScenarioName(unique[curIdx - 1].name);
    }} else if (e.key === "h" || e.key === "H") {{
      themeHolesToggleBtn.click();
    }}
  }});

  renderSidebar();
  renderCurrentFrame();
</script>
</body>
</html>
"##
    )
}

#[cfg(test)]
const GALLERY_EXTRA_CSS: &str = r##"
  .search-box {
    margin-top: 12px;
    position: relative;
  }

  .search-box input {
    width: 100%;
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 7px 10px;
    color: var(--fg);
    font-size: 12px;
    outline: none;
  }

  .search-box input:focus {
    border-color: var(--primary);
  }

  .scenario-list {
    overflow-y: auto;
    flex: 1;
    padding: 8px;
  }

  .category-group {
    margin-bottom: 16px;
  }

  .category-title {
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.8px;
    color: var(--fg-dim);
    padding: 6px 8px;
  }

  .scenario-item {
    padding: 8px 10px;
    border-radius: 6px;
    cursor: pointer;
    margin-bottom: 3px;
    display: flex;
    flex-direction: column;
    gap: 2px;
    transition: background 0.09s ease;
  }

  .scenario-item:hover {
    background: var(--bg-card-hover);
  }

  .scenario-item.active {
    background: var(--bg-card);
    border-left: 3px solid var(--primary);
  }

  .scenario-item-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .scenario-name {
    font-size: 13px;
    font-weight: 600;
    font-family: var(--font-mono);
  }

  .badge {
    font-size: 10px;
    padding: 2px 5px;
    border-radius: 4px;
    font-weight: 600;
  }

  .badge-pass {
    background: rgba(115, 201, 145, 0.2);
    color: var(--success);
  }

  .badge-violation {
    background: rgba(224, 108, 117, 0.25);
    color: var(--error);
  }

  .scenario-desc {
    font-size: 11px;
    color: var(--fg-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .diag-ok {
    color: var(--success);
  }

  .diag-error {
    color: var(--error);
    margin-bottom: 4px;
  }
"##;
