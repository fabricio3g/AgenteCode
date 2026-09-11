#[test]
fn parse_downloaded_models_dev_if_present() {
    let path = std::env::temp_dir().join("models_dev_sample.json");
    if !path.exists() {
        eprintln!("skip: no sample at {}", path.display());
        return;
    }
    let text = std::fs::read_to_string(&path).unwrap();
    let c = agente_core::catalog::ModelCatalog::parse_json(&text)
        .expect("full models.dev should parse");
    assert!(c.model_count() > 100);
    assert!(c.reasoning_options_count() > 100);
    let m = c
        .find_model("deepseek", "deepseek-v4-flash")
        .expect("deepseek-v4-flash");
    assert!(m.capabilities.reasoning);
    assert!(
        !m.reasoning_options.is_empty(),
        "must have reasoning_options"
    );
    println!("flash options: {:?}", m.reasoning_options);
    println!("opts count: {}", c.reasoning_options_count());
}
