//! Agent Skills (<https://agentskills.io>): folders with a `SKILL.md`
//! (frontmatter `name` + `description`, markdown instructions) plus optional
//! `scripts/`, `references/` and `assets/`.
//!
//! Loading is progressive:
//! 1. **Catalog** — every skill's name + description rides in the `skill`
//!    tool's description, so the model always knows what exists.
//! 2. **Instructions** — the model (or the user, with `/skill-name`) activates
//!    a skill; its body arrives wrapped in `<skill_content name="…">` with the
//!    skill directory and a listing of its bundled files.
//! 3. **Resources** — the model reads bundled files on demand with
//!    `read_file` (skill directories are readable even outside the project).
//!
//! Skills are discovered in the client's own folders and in the cross-client
//! `.agents/skills` and `.claude/skills` locations, user-level first and
//! project-level last, so a project skill overrides a user skill of the same
//! name. Loading is lenient: a missing description is the only reason to
//! skip a skill.

use std::path::{Path, PathBuf};

/// Name of the activation tool.
pub const SKILL_TOOL: &str = "skill";
/// Opening of an activated skill block (followed by the name and `">`).
pub const SKILL_OPEN: &str = "<skill_content name=\"";
/// Closing of an activated skill block.
pub const SKILL_CLOSE: &str = "</skill_content>";

/// Descriptions longer than the spec's limit are cut in the catalog.
const MAX_DESCRIPTION_CHARS: usize = 1024;
/// Bundled files listed on activation (not read — the model reads on demand).
const MAX_RESOURCES: usize = 60;
const MAX_RESOURCE_DEPTH: usize = 4;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SkillScope {
    /// `~/.agente/skills`, `~/.agents/skills`, … — every project.
    User,
    /// `<project>/.agente/skills`, … — travels with the repository.
    Project,
}

impl SkillScope {
    pub fn label(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Project => "project",
        }
    }
}

#[derive(Debug, Clone)]
pub struct Skill {
    pub name: String,
    pub description: String,
    /// Absolute path of the `SKILL.md`.
    pub source: PathBuf,
    /// The skill directory (parent of `SKILL.md`); relative paths in the
    /// instructions resolve against it.
    pub dir: PathBuf,
    pub scope: SkillScope,
    /// `false` when the frontmatter sets `disable-model-invocation: true`:
    /// the skill stays out of the model's catalog and only `/name` runs it.
    pub model_invocable: bool,
    /// Frontmatter `compatibility` (environment requirements), if any.
    pub compatibility: Option<String>,
}

/// Skill folders to scan, lowest precedence first.
pub fn skill_roots(project_dir: &str) -> Vec<(PathBuf, SkillScope)> {
    let mut roots = Vec::new();
    if let Some(home) = dirs::home_dir() {
        for dir in [
            home.join(".claude").join("skills"),
            home.join(".agents").join("skills"),
            home.join(".config").join("agente").join("skills"),
            home.join(".agente").join("skills"),
        ] {
            roots.push((dir, SkillScope::User));
        }
    }
    let project = Path::new(project_dir);
    for dir in [
        project.join(".claude").join("skills"),
        project.join(".agents").join("skills"),
        project.join(".agente").join("skills"),
    ] {
        roots.push((dir, SkillScope::Project));
    }
    roots
}

/// Every skill visible from `project_dir`, sorted by name. A later root
/// shadows an earlier skill of the same name (project over user, native
/// `.agente` over the cross-client folders).
pub fn discover(project_dir: &str) -> Vec<Skill> {
    discover_in(&skill_roots(project_dir))
}

fn discover_in(roots: &[(PathBuf, SkillScope)]) -> Vec<Skill> {
    let mut out: Vec<Skill> = Vec::new();
    // The same folder can appear twice (project dir == home); read it once.
    let mut seen_roots: Vec<PathBuf> = Vec::new();
    for (root, scope) in roots {
        let canonical = std::fs::canonicalize(root).unwrap_or_else(|_| root.clone());
        if seen_roots.contains(&canonical) {
            continue;
        }
        seen_roots.push(canonical);
        let Ok(entries) = std::fs::read_dir(root) else {
            continue;
        };
        let mut dirs: Vec<PathBuf> = entries
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.is_dir() && p.join("SKILL.md").is_file())
            .collect();
        dirs.sort();
        for dir in dirs {
            let Some(skill) = load(&dir, *scope) else {
                continue;
            };
            if let Some(old) = out.iter().position(|s| s.name == skill.name) {
                tracing::debug!(
                    skill = %skill.name,
                    shadowed = %out[old].source.display(),
                    by = %skill.source.display(),
                    "skill shadowed"
                );
                out.remove(old);
            }
            out.push(skill);
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

fn load(dir: &Path, scope: SkillScope) -> Option<Skill> {
    let source = dir.join("SKILL.md");
    let raw = std::fs::read_to_string(&source).ok()?;
    let (meta, _body) = super::split_frontmatter(&raw);
    let folder = dir.file_name()?.to_str()?.to_string();
    let name = meta
        .get("name")
        .map(|n| n.trim().to_string())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| folder.clone());
    if name != folder {
        tracing::debug!(skill = %name, folder = %folder, "skill name differs from its folder");
    }
    let Some(description) = meta
        .get("description")
        .map(|d| d.trim().to_string())
        .filter(|d| !d.is_empty())
    else {
        tracing::warn!(path = %source.display(), "skill skipped: no description");
        return None;
    };
    let source = std::fs::canonicalize(&source).unwrap_or(source);
    let dir = source
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| dir.to_path_buf());
    Some(Skill {
        name,
        description,
        source,
        dir,
        scope,
        model_invocable: !super::truthy(meta.get("disable-model-invocation")),
        compatibility: meta.get("compatibility").cloned().filter(|c| !c.is_empty()),
    })
}

/// Look one skill up by name.
pub fn find(project_dir: &str, name: &str) -> Option<Skill> {
    discover(project_dir).into_iter().find(|s| s.name == name)
}

/// Whether `path` (already canonical) lies inside a skill directory, so
/// the read tools may open bundled files that live outside the project.
pub fn within_skill_dir(project_dir: &str, path: &Path) -> bool {
    discover(project_dir)
        .iter()
        .any(|skill| path.starts_with(&skill.dir))
}

impl Skill {
    /// The instructions: `SKILL.md` without its frontmatter, read now so an
    /// edited skill is picked up on the next activation.
    pub fn body(&self) -> std::io::Result<String> {
        let raw = std::fs::read_to_string(&self.source)?;
        Ok(super::split_frontmatter(&raw).1.trim().to_string())
    }

    /// Files bundled with the skill, relative to its directory (capped).
    pub fn resources(&self) -> (Vec<String>, bool) {
        let mut files = Vec::new();
        let mut truncated = false;
        collect_files(&self.dir, &self.dir, 0, &mut files, &mut truncated);
        files.sort();
        (files, truncated)
    }

    /// The block the model receives on activation.
    pub fn content_block(&self) -> std::io::Result<String> {
        let body = self.body()?;
        let mut out = format!("{SKILL_OPEN}{}\">\n{body}\n", self.name);
        if let Some(compatibility) = &self.compatibility {
            out.push_str(&format!("\nCompatibility: {compatibility}\n"));
        }
        out.push_str(&format!(
            "\nSkill directory: {}\nRelative paths in this skill are relative to the skill directory; \
             use absolute paths in tool calls.\n",
            self.dir.display()
        ));
        let (files, truncated) = self.resources();
        if !files.is_empty() {
            out.push_str("<skill_resources>\n");
            for file in &files {
                out.push_str(&format!("  <file>{file}</file>\n"));
            }
            if truncated {
                out.push_str("  <!-- listing truncated -->\n");
            }
            out.push_str("</skill_resources>\n");
        }
        out.push_str(SKILL_CLOSE);
        Ok(out)
    }
}

fn collect_files(
    root: &Path,
    dir: &Path,
    depth: usize,
    out: &mut Vec<String>,
    truncated: &mut bool,
) {
    if depth > MAX_RESOURCE_DEPTH {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut paths: Vec<PathBuf> = entries.flatten().map(|e| e.path()).collect();
    paths.sort();
    for path in paths {
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if name.starts_with('.') || name == "node_modules" || name == "__pycache__" {
            continue;
        }
        if path.is_dir() {
            collect_files(root, &path, depth + 1, out, truncated);
        } else if depth > 0 || name != "SKILL.md" {
            if out.len() >= MAX_RESOURCES {
                *truncated = true;
                return;
            }
            if let Ok(rel) = path.strip_prefix(root) {
                out.push(rel.to_string_lossy().replace('\\', "/"));
            }
        }
    }
}

/// The activation tool's description: how to use skills, then the catalog.
/// Deterministic for a given skill set, so it stays in the cached prefix.
pub fn tool_description(skills: &[Skill]) -> String {
    let mut out = String::from(
        "Load a skill: specialized instructions for a kind of task. Before starting work \
         that matches a skill below, call this tool with the skill's name and follow the \
         instructions it returns.\n\
         Skills already loaded in this conversation (a <skill_content> block) are still in \
         effect — do not load them again. Read the files a skill references with read_file, \
         resolving relative paths against the skill directory it reports.\n\n\
         <available_skills>\n",
    );
    for skill in skills {
        let description: String = skill
            .description
            .chars()
            .take(MAX_DESCRIPTION_CHARS)
            .collect();
        out.push_str(&format!(
            "<skill name=\"{}\">{}</skill>\n",
            skill.name,
            description.replace('\n', " ")
        ));
    }
    out.push_str("</available_skills>");
    out
}

/// A user's `/name args` invocation: the skill block, then what to do.
pub fn user_invocation(skill: &Skill, args: &str) -> std::io::Result<String> {
    let block = skill.content_block()?;
    let request = if args.trim().is_empty() {
        format!("Use the {} skill above for this task.", skill.name)
    } else {
        args.trim().to_string()
    };
    Ok(format!("{block}\n\n{request}"))
}

/// Every complete skill block in `text`, as `(name, block)`.
pub fn skill_blocks(text: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut rest = text;
    while let Some(start) = rest.find(SKILL_OPEN) {
        let after = &rest[start..];
        let Some(end) = after.find(SKILL_CLOSE) else {
            break;
        };
        let block = &after[..end + SKILL_CLOSE.len()];
        let name = block[SKILL_OPEN.len()..]
            .split('"')
            .next()
            .unwrap_or_default()
            .to_string();
        out.push((name, block.to_string()));
        rest = &after[end + SKILL_CLOSE.len()..];
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_skill(root: &Path, folder: &str, frontmatter: &str, body: &str) -> PathBuf {
        let dir = root.join(folder);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("SKILL.md"),
            format!("---\n{frontmatter}\n---\n{body}"),
        )
        .unwrap();
        dir
    }

    #[test]
    fn project_skills_shadow_user_skills_and_undescribed_ones_are_skipped() {
        let tmp = tempfile::tempdir().unwrap();
        let user = tmp.path().join("user");
        let project = tmp.path().join("project");
        write_skill(
            &user,
            "review",
            "name: review\ndescription: user review",
            "U",
        );
        write_skill(&user, "pdf", "name: pdf\ndescription: Handle PDFs", "P");
        write_skill(
            &project,
            "review",
            "name: review\ndescription: project review",
            "R",
        );
        write_skill(&project, "broken", "name: broken", "no description");

        let skills = discover_in(&[(user, SkillScope::User), (project, SkillScope::Project)]);
        let names: Vec<&str> = skills.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, ["pdf", "review"]);
        let review = skills.iter().find(|s| s.name == "review").unwrap();
        assert_eq!(review.description, "project review");
        assert_eq!(review.scope, SkillScope::Project);
    }

    #[test]
    fn lenient_frontmatter_from_other_clients_parses() {
        let tmp = tempfile::tempdir().unwrap();
        write_skill(
            tmp.path(),
            "pdf-processing",
            "name: pdf-processing\n\
             description: >\n  Extract text from PDFs.\n  Use when: the user mentions PDFs.\n\
             license: Apache-2.0\n\
             metadata:\n  author: example\n  version: \"1.0\"\n\
             disable-model-invocation: true",
            "# PDF\nSteps.",
        );
        let skills = discover_in(&[(tmp.path().to_path_buf(), SkillScope::User)]);
        let skill = &skills[0];
        assert_eq!(
            skill.description,
            "Extract text from PDFs. Use when: the user mentions PDFs."
        );
        assert!(!skill.model_invocable);
        assert_eq!(skill.body().unwrap(), "# PDF\nSteps.");
    }

    #[test]
    fn activation_block_lists_resources_without_reading_them() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = write_skill(
            tmp.path(),
            "data",
            "name: data\ndescription: Analyze data",
            "Run scripts/run.py",
        );
        std::fs::create_dir_all(dir.join("scripts")).unwrap();
        std::fs::write(dir.join("scripts/run.py"), "print('secret body')").unwrap();
        std::fs::create_dir_all(dir.join(".git")).unwrap();
        std::fs::write(dir.join(".git/HEAD"), "x").unwrap();

        let skill = &discover_in(&[(tmp.path().to_path_buf(), SkillScope::User)])[0];
        let block = skill.content_block().unwrap();
        assert!(block.starts_with("<skill_content name=\"data\">\nRun scripts/run.py"));
        assert!(block.contains("<file>scripts/run.py</file>"));
        assert!(
            !block.contains("secret body"),
            "resources are listed, not read"
        );
        assert!(!block.contains(".git"));
        assert!(block.contains(&format!("Skill directory: {}", skill.dir.display())));
        assert_eq!(
            skill_blocks(&block),
            vec![("data".to_string(), block.clone())]
        );
    }

    #[test]
    fn catalog_lists_every_skill_once() {
        let tmp = tempfile::tempdir().unwrap();
        write_skill(tmp.path(), "a", "description: first", "");
        write_skill(tmp.path(), "b", "description: second", "");
        let skills = discover_in(&[(tmp.path().to_path_buf(), SkillScope::User)]);
        let text = tool_description(&skills);
        assert!(text.contains("<skill name=\"a\">first</skill>"), "{text}");
        assert!(text.contains("<skill name=\"b\">second</skill>"), "{text}");
        assert_eq!(text, tool_description(&skills), "stable for caching");
    }
}
