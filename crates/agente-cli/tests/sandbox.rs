//! The bot sandbox, end to end: real commands through the real `agente
//! __sandbox` helper, trying to get out. Linux only; skipped (with a note)
//! where the kernel has no Landlock.

#![cfg(target_os = "linux")]

use std::process::Command;

/// Run `script` boxed in `project` the way a bot's shell is; true when it ran.
fn boxed(project: &std::path::Path, network: bool, script: &str) -> (bool, String) {
    let plan = serde_json::json!({
        "policy": { "network": network, "file_mb": 1, "cpu_secs": 5 },
        "project": project,
        "tmp": project.join(".tmp"),
    });
    let out = Command::new(env!("CARGO_BIN_EXE_agente"))
        .args(["__sandbox", &plan.to_string(), "--", "sh", "-c", script])
        .current_dir(project)
        .output()
        .expect("the agente binary runs");
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    (out.status.success(), text)
}

#[test]
fn a_boxed_command_stays_in_its_box() {
    let dir = tempfile::tempdir().unwrap();
    let project = dir.path();
    std::fs::create_dir_all(project.join(".tmp")).unwrap();

    // Without Landlock the helper refuses to run anything: say so and stop.
    let (ran, text) = boxed(project, false, "true");
    if !ran && text.contains("Landlock") {
        eprintln!("skipped: {text}");
        return;
    }
    assert!(ran, "{text}");

    let home = std::env::var("HOME").unwrap_or_else(|_| "/root".into());
    let parent = std::process::id();
    let cases: &[(&str, bool, String, bool)] = &[
        (
            "writes its project",
            false,
            "echo hi > in.txt && cat in.txt".into(),
            true,
        ),
        (
            "writes its temp folder",
            false,
            "echo t > .tmp/t".into(),
            true,
        ),
        (
            "reads the home folder",
            false,
            format!("ls '{home}'"),
            false,
        ),
        (
            "writes outside",
            false,
            format!("echo x > '{home}/agente-escape'"),
            false,
        ),
        (
            "reads the parent's environment",
            false,
            format!("cat /proc/{parent}/environ"),
            false,
        ),
        ("lists /dev/shm", false, "ls /dev/shm".into(), false),
        ("uses /dev/null", false, "echo x > /dev/null".into(), true),
        (
            "writes past the size limit",
            false,
            "head -c 2000000 /dev/zero > big".into(),
            false,
        ),
        (
            "signals the parent",
            false,
            format!("kill -0 {parent}"),
            false,
        ),
    ];
    for (what, network, script, allowed) in cases {
        let (ran, text) = boxed(project, *network, script);
        assert_eq!(ran, *allowed, "{what}: {text}");
    }

    // Sockets, where python3 is there to open one.
    if Command::new("python3").arg("--version").output().is_ok() {
        let inet = "python3 -c 'import socket; socket.socket()'";
        let unix = "python3 -c 'import socket; socket.socket(socket.AF_UNIX)'";
        assert!(
            !boxed(project, false, inet).0,
            "an IP socket with the network off"
        );
        assert!(
            !boxed(project, false, unix).0,
            "a Unix socket with the network off"
        );
        assert!(
            boxed(project, true, inet).0,
            "an IP socket with the network on"
        );
        assert!(
            !boxed(project, true, unix).0,
            "a Unix socket, network or not"
        );
    }
}
