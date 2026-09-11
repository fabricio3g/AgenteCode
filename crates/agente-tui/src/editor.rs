use std::process::Command;

pub fn open_temp_editor(content: &str) -> anyhow::Result<Option<String>> {
    let editor = std::env::var("EDITOR")
        .or_else(|_| std::env::var("VISUAL"))
        .unwrap_or_else(|_| "vim".to_string());

    let temp_dir = std::env::temp_dir();
    let temp_path = temp_dir.join(format!("agente_msg_{}.md", uuid::Uuid::new_v4()));
    std::fs::write(&temp_path, content)?;

    let editor_cmd = editor.split_whitespace().next().unwrap_or(&editor);
    let editor_args: Vec<&str> = editor.split_whitespace().skip(1).collect();

    let status = Command::new(editor_cmd)
        .args(&editor_args)
        .arg(&temp_path)
        .status()?;

    if status.success() {
        let result = std::fs::read_to_string(&temp_path)?;
        let _ = std::fs::remove_file(&temp_path);
        if result.trim().is_empty() || result == content {
            Ok(None)
        } else {
            Ok(Some(result))
        }
    } else {
        let _ = std::fs::remove_file(&temp_path);
        Ok(None)
    }
}
