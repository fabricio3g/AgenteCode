//! The box a bot's commands run in.
//!
//! A boxed command can write only its project folder (a bot's workspace) and
//! a private temp folder inside it, can read the system's programs and
//! libraries but nothing under the user's home (no keys, no other bots, no
//! `~/.agente`), gets no network unless its policy allows it, and runs under
//! file-size and CPU-time limits. Anything a bot does outside its box (model
//! calls, web search, messaging) happens in the daemon, not in the box.
//!
//! Backends:
//! - **Linux:** the `agente` binary re-executes itself as a small helper
//!   ([`HELPER_ARG`]) that applies Landlock (filesystem, signals), a seccomp
//!   filter (no sockets but Unix ones) and resource limits, then `exec`s the
//!   command. Unprivileged; kernel 5.13+.
//! - **macOS:** `sandbox-exec` with a Seatbelt profile made per command.
//! - **Elsewhere** (Windows for now): no backend. [`available`] says so, and
//!   callers fall back to a clean environment plus approvals.

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// The first argument that turns the `agente` binary into the Linux sandbox
/// helper: `agente __sandbox <policy json> -- <program> [args…]`.
pub const HELPER_ARG: &str = "__sandbox";

/// The private temp folder inside a boxed project folder.
pub const TMP_DIR: &str = ".tmp";

/// What a boxed command may do beyond its project folder.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct SandboxPolicy {
    /// Outgoing network. Off by default; name-based allowlists come with the
    /// daemon's egress proxy.
    pub network: bool,
    /// Extra folders it may read (the owner shares them explicitly).
    pub read: Vec<PathBuf>,
    /// Extra folders it may write.
    pub write: Vec<PathBuf>,
    /// Largest file it may write, in MB.
    pub file_mb: u64,
    /// CPU time it may use, in seconds (wall-clock time is the tool's timeout).
    pub cpu_secs: u64,
}

impl Default for SandboxPolicy {
    fn default() -> Self {
        Self {
            network: false,
            read: Vec::new(),
            write: Vec::new(),
            file_mb: 1024,
            cpu_secs: 600,
        }
    }
}

/// Which backend boxes commands on this machine.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Backend {
    Landlock,
    Seatbelt,
    /// No sandbox here: commands can't be boxed.
    None,
}

/// The backend this machine has, probed once.
pub fn backend() -> Backend {
    static BACKEND: std::sync::OnceLock<Backend> = std::sync::OnceLock::new();
    *BACKEND.get_or_init(probe)
}

/// Whether commands can be boxed here.
pub fn available() -> bool {
    backend() != Backend::None
}

#[cfg(target_os = "linux")]
fn probe() -> Backend {
    if linux::supported() && helper().is_some() {
        Backend::Landlock
    } else {
        Backend::None
    }
}

#[cfg(target_os = "macos")]
fn probe() -> Backend {
    if Path::new(macos::SANDBOX_EXEC).exists() {
        Backend::Seatbelt
    } else {
        Backend::None
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn probe() -> Backend {
    Backend::None
}

/// The program that applies the box on Linux: `AGENTE_SANDBOX_HELPER`, or
/// this process's own binary when it is `agente` (the TUI, the daemon). A
/// host that isn't (an embedding) sets the variable or goes without.
#[cfg(target_os = "linux")]
fn helper() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("AGENTE_SANDBOX_HELPER") {
        let path = PathBuf::from(path);
        return path.is_file().then_some(path);
    }
    let exe = std::env::current_exe().ok()?;
    let name = exe.file_stem()?.to_string_lossy().to_lowercase();
    name.starts_with("agente").then_some(exe)
}

/// The command that runs `sh -c <command>` boxed in `project_dir`, or an
/// error saying why it can't (never an unboxed fallback).
pub fn command(
    command: &str,
    project_dir: &str,
    policy: &SandboxPolicy,
) -> Result<processkit::Command, String> {
    let project = Path::new(project_dir);
    let tmp = project.join(TMP_DIR);
    std::fs::create_dir_all(&tmp)
        .map_err(|error| format!("could not make the box's temp folder: {error}"))?;
    boxed(command, project, &tmp, policy)
}

#[cfg(target_os = "linux")]
fn boxed(
    command: &str,
    project: &Path,
    tmp: &Path,
    policy: &SandboxPolicy,
) -> Result<processkit::Command, String> {
    let helper = helper().ok_or("the sandbox helper (the agente binary) wasn't found")?;
    if !linux::supported() {
        return Err("this Linux kernel has no Landlock (5.13+ with Landlock enabled)".into());
    }
    let plan = linux::Plan {
        policy: policy.clone(),
        project: project.to_path_buf(),
        tmp: tmp.to_path_buf(),
    };
    let plan = serde_json::to_string(&plan).map_err(|error| error.to_string())?;
    Ok(processkit::Command::new(helper)
        .args([HELPER_ARG, plan.as_str(), "--", "sh", "-c", command])
        .env("TMPDIR", tmp))
}

#[cfg(target_os = "macos")]
fn boxed(
    command: &str,
    project: &Path,
    tmp: &Path,
    policy: &SandboxPolicy,
) -> Result<processkit::Command, String> {
    let profile = macos::profile(project, tmp, policy);
    Ok(processkit::Command::new(macos::SANDBOX_EXEC)
        .args(["-p", profile.as_str(), "sh", "-c", command])
        .env("TMPDIR", tmp))
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn boxed(
    _command: &str,
    _project: &Path,
    _tmp: &Path,
    _policy: &SandboxPolicy,
) -> Result<processkit::Command, String> {
    Err("programs can't be boxed on this system yet".into())
}

/// The helper's entry point (Linux): apply the box to this process, then
/// `exec` the command. Called by `agente` when its first argument is
/// [`HELPER_ARG`]; never returns. `args` are the arguments after it.
#[cfg(target_os = "linux")]
pub fn helper_main(args: &[String]) -> ! {
    linux::helper_main(args)
}

/// Not available off Linux: the helper only exists there.
#[cfg(not(target_os = "linux"))]
pub fn helper_main(_args: &[String]) -> ! {
    eprintln!("agente: the sandbox helper only runs on Linux");
    std::process::exit(126)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_default_policy_is_closed() {
        let policy = SandboxPolicy::default();
        assert!(!policy.network);
        assert!(policy.read.is_empty() && policy.write.is_empty());
    }

    #[test]
    fn a_policy_reads_from_partial_json() {
        let policy: SandboxPolicy = serde_json::from_str(r#"{ "network": true }"#).unwrap();
        assert!(policy.network);
        assert_eq!(policy.cpu_secs, SandboxPolicy::default().cpu_secs);
    }
}
