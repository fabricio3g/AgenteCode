//! The macOS box: `sandbox-exec -p <profile> sh -c <command>`, with a
//! Seatbelt profile made for the command. Everything is denied unless
//! listed: the system's programs and libraries are readable, the project
//! (and its temp folder) is readable and writable, and the user's home
//! (keys, `~/.agente`, other bots) is never listed. The network, and the
//! system resolver it needs, only when the policy allows it.
//!
//! Written to the same shape as the Seatbelt profiles Codex and Claude Code
//! ship; exercise it on a Mac before relying on it.

use std::path::Path;

use super::SandboxPolicy;

pub(super) const SANDBOX_EXEC: &str = "/usr/bin/sandbox-exec";

/// Folders a boxed program may read (and run programs from).
const SYSTEM_READ: &[&str] = &[
    "/usr",
    "/bin",
    "/sbin",
    "/System",
    "/Library",
    "/private/etc",
    "/private/var/db",
    "/opt",
    "/Applications",
    "/dev",
];

/// Mach services that hand out secrets (the keychain): never reachable.
const DENIED_SERVICES: &[&str] = &[
    "com.apple.SecurityServer",
    "com.apple.securityd",
    "com.apple.securityd.xpc",
    "com.apple.security.agent",
];

/// A Seatbelt string literal.
fn quoted(path: &Path) -> String {
    let text = path.to_string_lossy();
    format!("\"{}\"", text.replace('\\', "\\\\").replace('"', "\\\""))
}

/// The real path (`/var` is `/private/var`): Seatbelt matches resolved paths.
fn real(path: &Path) -> std::path::PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

pub(super) fn profile(project: &Path, tmp: &Path, policy: &SandboxPolicy) -> String {
    let mut out = String::from(
        "(version 1)\n\
         (deny default)\n\
         (allow process-exec process-fork)\n\
         (allow signal (target same-sandbox))\n\
         (allow sysctl-read)\n\
         (allow ipc-posix-shm)\n\
         (allow mach-lookup)\n\
         (allow file-read-metadata)\n\
         (allow file-read* (literal \"/\") (literal \"/private\") (literal \"/var\") (literal \"/etc\") (literal \"/tmp\"))\n",
    );
    for service in DENIED_SERVICES {
        out.push_str(&format!("(deny mach-lookup (global-name \"{service}\"))\n"));
    }
    let mut readable: Vec<std::path::PathBuf> = SYSTEM_READ
        .iter()
        .map(|path| Path::new(path).to_path_buf())
        .collect();
    readable.extend(policy.read.iter().cloned());
    for path in readable {
        out.push_str(&format!(
            "(allow file-read* (subpath {}))\n",
            quoted(&real(&path))
        ));
    }
    let mut writable = vec![project.to_path_buf(), tmp.to_path_buf()];
    writable.extend(policy.write.iter().cloned());
    for path in writable {
        out.push_str(&format!(
            "(allow file-read* file-write* (subpath {}))\n",
            quoted(&real(&path))
        ));
    }
    out.push_str(
        "(allow file-write* (literal \"/dev/null\") (literal \"/dev/zero\") (literal \"/dev/tty\"))\n",
    );
    if policy.network {
        out.push_str(
            "(allow network-outbound)\n\
             (allow network-inbound (local ip))\n\
             (allow system-socket)\n\
             (allow network-outbound (remote unix-socket (path-literal \"/private/var/run/mDNSResponder\")))\n",
        );
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_profile_denies_by_default_and_names_the_project() {
        let project = Path::new("/nonexistent/work \"q\"");
        let profile = profile(project, &project.join(".tmp"), &SandboxPolicy::default());
        assert!(profile.starts_with("(version 1)\n(deny default)"));
        assert!(profile.contains("(subpath \"/nonexistent/work \\\"q\\\"\")"));
        assert!(!profile.contains("network-outbound"));
        assert!(profile.contains("com.apple.SecurityServer"));
    }
}
