fn main() {
    napi_build::setup();

    #[cfg(windows)]
    {
        println!("cargo:rerun-if-changed=build.rs");
        let out_dir = std::env::var("OUT_DIR").expect("OUT_DIR");
        let path = std::path::Path::new(&out_dir);
        let target_dir = path.ancestors().nth(3).expect("target dir");
        let src = target_dir.join(format!("agente_node.{}", std::env::consts::DLL_SUFFIX));
        let targets = [
            target_dir.join("index.node"),
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("index.node"),
        ];
        for dst in &targets {
            if src.exists() {
                std::fs::copy(&src, dst).unwrap_or_else(|error| {
                    panic!(
                        "agente-node build: failed to copy {} to {}: {error}",
                        src.display(),
                        dst.display()
                    )
                });
            }
        }
    }
}
