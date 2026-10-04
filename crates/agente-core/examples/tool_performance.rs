//! Reproducible local tool benchmark; no providers, credentials or user files.
use agente_core::tools::ToolRegistry;
use serde_json::json;
use std::time::Instant;

async fn measure(registry: &ToolRegistry, label: &str, tool: &str, args: serde_json::Value) {
    let mut times = Vec::new();
    for _ in 0..10 {
        let started = Instant::now();
        let result = registry.execute(tool, args.clone()).await.unwrap();
        assert!(!result.is_empty());
        times.push(started.elapsed().as_secs_f64() * 1000.0);
    }
    times.sort_by(f64::total_cmp);
    println!("{label}: median={:.3}ms p95={:.3}ms", times[5], times[9]);
}

#[tokio::main]
async fn main() {
    let fixture = tempfile::tempdir().unwrap();
    let root = fixture.path();
    let body = "fn sample() { /* ordinary source text */ }\n".repeat(100);
    for folder in 0..60 {
        let dir = root.join(format!("src{folder:02}"));
        std::fs::create_dir(&dir).unwrap();
        for file in 0..100 {
            std::fs::write(dir.join(format!("file{file:03}.rs")), &body).unwrap();
        }
    }
    std::fs::write(root.join("src59/file099.rs"), "UNIQUE_NEEDLE\n").unwrap();
    std::fs::write(root.join("small.rs"), &body).unwrap();
    std::fs::write(
        root.join("large.txt"),
        "a representative source line\n".repeat(200_000),
    )
    .unwrap();
    let registry = ToolRegistry::with_agents(root.to_string_lossy(), &[]);
    println!("Synthetic tree: 6000 source files, ~25 MiB; 10 calls per case");
    measure(
        &registry,
        "grep no matches",
        "grep",
        json!({"pattern":"ABSENT_NEEDLE","glob":"*.rs"}),
    )
    .await;
    measure(
        &registry,
        "grep rare match",
        "grep",
        json!({"pattern":"UNIQUE_NEEDLE","glob":"*.rs"}),
    )
    .await;
    measure(
        &registry,
        "grep bounded context",
        "grep",
        json!({"pattern":"ordinary","path":"small.rs","context":3,"limit":20}),
    )
    .await;
    measure(
        &registry,
        "read whole small file",
        "read_file",
        json!({"path":"small.rs"}),
    )
    .await;
    measure(
        &registry,
        "read deep range",
        "read_file",
        json!({"path":"large.txt","start_line":190000,"end_line":190100}),
    )
    .await;
    let started = Instant::now();
    let results = futures::future::join_all(
        (0..8).map(|_| registry.execute("grep", json!({"pattern":"UNIQUE_NEEDLE","glob":"*.rs"}))),
    )
    .await;
    for result in results {
        assert!(result.unwrap().contains("UNIQUE_NEEDLE"));
    }
    println!(
        "8 concurrent searches: {:.3}ms",
        started.elapsed().as_secs_f64() * 1000.0
    );
}
