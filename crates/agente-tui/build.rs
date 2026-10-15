//! Stamps the short commit the TUI was built from into `AGENTE_BUILD`, so the
//! welcome card reads `v0.2.3 · a1b2c3d` like the desktop's Settings rail.
//! Empty when git is unavailable (a source tarball), and the card then shows
//! the release alone.

use std::process::Command;

fn main() {
    let commit = Command::new("git")
        .args(["rev-parse", "--short", "HEAD"])
        .output()
        .ok()
        .filter(|out| out.status.success())
        .and_then(|out| String::from_utf8(out.stdout).ok())
        .map(|text| text.trim().to_string())
        .unwrap_or_default();
    println!("cargo:rustc-env=AGENTE_BUILD={commit}");
    println!("cargo:rerun-if-changed=../../.git/HEAD");
    println!("cargo:rerun-if-changed=../../.git/refs/heads");
}
