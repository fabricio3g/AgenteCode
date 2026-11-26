//! Reproducible persistence benchmark; uses only a temporary synthetic store.
use agente_protocol::{Message, Role, SessionId, SessionInfo, SessionSnapshot, PROTOCOL_VERSION};
use agente_session::SessionStore;
use chrono::Utc;
use std::{fs, time::Instant};

fn measure(name: &str, mut action: impl FnMut()) {
    let mut times = Vec::new();
    for _ in 0..5 {
        let started = Instant::now();
        action();
        times.push(started.elapsed().as_secs_f64() * 1000.0);
    }
    times.sort_by(f64::total_cmp);
    println!("{name}: median {:.3} ms (5 repetitions)", times[2]);
}

fn main() {
    let root = std::env::temp_dir().join(format!("agente-persistence-bench-{}", SessionId::new()));
    let store = SessionStore::open(&root).unwrap();
    let snapshot = SessionSnapshot {
        session_id: SessionId::new(),
        revision: 1,
        conversation: (0..128)
            .map(|_| Message {
                role: Role::Assistant,
                content: "synthetic transcript\n".repeat(820),
                tool_calls: None,
                tool_call_id: None,
                thinking: None,
                thinking_signature: None,
                continuation: None,
                attachments: vec![],
            })
            .collect(),
    };
    for _ in 0..24 {
        let id = SessionId::new();
        let now = Utc::now();
        let info = SessionInfo {
            session_id: id,
            title: "Synthetic session".into(),
            first_prompt: String::new(),
            project_dir: "/synthetic".into(),
            created_at: now,
            last_active: now,
            message_count: 128,
            provider: String::new(),
            model: String::new(),
            thinking_level: String::new(),
            profile: None,
            instance_id: None,
            driver_kind: None,
            external_session_id: None,
            worktree: None,
        };
        let bytes = serde_json::to_vec(&serde_json::json!({
            "protocol_version": PROTOCOL_VERSION, "info": info,
            "clients": { "desktop": { "transcript": "synthetic state\n".repeat(35000) } }
        }))
        .unwrap();
        fs::write(root.join(format!("{id}.meta.json")), bytes).unwrap();
    }
    println!("128 messages (~2 MiB), 24 metadata files (~0.5 MiB each)");
    measure("snapshot write", || {
        store.write_snapshot(&snapshot, 0).unwrap()
    });
    measure("snapshot recover", || {
        assert_eq!(
            store
                .recover(snapshot.session_id)
                .unwrap()
                .snapshot
                .conversation
                .len(),
            128
        );
    });
    measure("session list", || {
        assert_eq!(store.list_infos().unwrap().len(), 24);
    });
    drop(store);
    fs::remove_dir_all(root).unwrap();
}
