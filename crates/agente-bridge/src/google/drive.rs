// ── Google Drive v3 ───────────────────────────────────────────────────
// Find files, pull one down as a real file (a Sheet as .xlsx, a Doc as .docx
// or markdown) so the rest of Agente — viewers, document tools, the shell —
// can work on it, and push a local file back up, optionally converted into a
// native Doc/Sheet/Slides file.

use super::{encode, Google};
use serde_json::{json, Value};
use sha2::Digest;
use std::path::{Path, PathBuf};

const API: &str = "https://www.googleapis.com/drive/v3/files";
const UPLOAD: &str = "https://www.googleapis.com/upload/drive/v3/files";
/// Characters of a text export shown inline next to its path.
const PREVIEW_CHARS: usize = 4000;

const DOC: &str = "application/vnd.google-apps.document";
const SHEET: &str = "application/vnd.google-apps.spreadsheet";
const SLIDES: &str = "application/vnd.google-apps.presentation";

pub fn kind_filter(kind: &str) -> Option<&'static str> {
    Some(match kind {
        "doc" | "document" => DOC,
        "sheet" | "spreadsheet" => SHEET,
        "slides" | "presentation" => SLIDES,
        "folder" => "application/vnd.google-apps.folder",
        _ => return None,
    })
}

fn kind_label(mime: &str) -> &str {
    match mime {
        DOC => "doc",
        SHEET => "sheet",
        SLIDES => "slides",
        "application/vnd.google-apps.folder" => "folder",
        other => other.rsplit('/').next().unwrap_or(other),
    }
}

/// Drive's query language wants single quotes and backslashes escaped.
fn quote(text: &str) -> String {
    text.replace('\\', "\\\\").replace('\'', "\\'")
}

pub fn find_query(query: &str, kind: Option<&str>) -> String {
    let mut clauses = vec!["trashed = false".to_string()];
    let query = query.trim();
    if !query.is_empty() {
        clauses.push(format!("name contains '{}'", quote(query)));
    }
    if let Some(mime) = kind.and_then(kind_filter) {
        clauses.push(format!("mimeType = '{mime}'"));
    }
    clauses.join(" and ")
}

pub async fn find(google: &Google, query: &str, kind: Option<&str>) -> Result<String, String> {
    let url = format!(
        "{API}?q={}&pageSize=25&orderBy=modifiedTime%20desc&supportsAllDrives=true&includeItemsFromAllDrives=true&fields={}",
        encode(&find_query(query, kind)),
        encode("files(id,name,mimeType,modifiedTime,webViewLink)")
    );
    let value = google.get_json(&url).await?;
    let files = value.get("files").and_then(Value::as_array).cloned().unwrap_or_default();
    if files.is_empty() {
        return Ok(format!("No Drive files match \"{query}\"."));
    }
    let mut lines = vec![format!("{} file(s), newest first:", files.len())];
    for file in &files {
        let get = |key: &str| file.get(key).and_then(Value::as_str).unwrap_or("");
        lines.push(format!(
            "- {} [{}] id={} · modified {} · {}",
            get("name"),
            kind_label(get("mimeType")),
            get("id"),
            get("modifiedTime").get(..10).unwrap_or(""),
            get("webViewLink"),
        ));
    }
    Ok(lines.join("\n"))
}

/// The export mime type and file extension for a requested format.
pub fn export_format(source_mime: &str, format: Option<&str>) -> Result<Option<(&'static str, &'static str)>, String> {
    let format = format.map(|f| f.trim().trim_start_matches('.').to_ascii_lowercase());
    let pick = |default: &'static str| format.clone().unwrap_or_else(|| default.to_string());
    let choice = match source_mime {
        DOC => match pick("docx").as_str() {
            "docx" => ("application/vnd.openxmlformats-officedocument.wordprocessingml.document", "docx"),
            "md" | "markdown" => ("text/markdown", "md"),
            "pdf" => ("application/pdf", "pdf"),
            "txt" | "text" => ("text/plain", "txt"),
            "html" => ("text/html", "html"),
            other => return Err(format!("A Doc exports as docx, md, pdf, txt or html — not {other}")),
        },
        SHEET => match pick("xlsx").as_str() {
            "xlsx" => ("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "xlsx"),
            "csv" => ("text/csv", "csv"),
            "pdf" => ("application/pdf", "pdf"),
            "ods" => ("application/vnd.oasis.opendocument.spreadsheet", "ods"),
            other => return Err(format!("A Sheet exports as xlsx, csv (first tab), pdf or ods — not {other}")),
        },
        SLIDES => match pick("pptx").as_str() {
            "pptx" => ("application/vnd.openxmlformats-officedocument.presentationml.presentation", "pptx"),
            "pdf" => ("application/pdf", "pdf"),
            "txt" | "text" => ("text/plain", "txt"),
            other => return Err(format!("Slides export as pptx, pdf or txt — not {other}")),
        },
        mime if mime.starts_with("application/vnd.google-apps.") => {
            return Err(format!("{} files cannot be downloaded", kind_label(mime)))
        }
        // Ordinary files download as they are.
        _ => return Ok(None),
    };
    Ok(Some(choice))
}

pub async fn pull(google: &Google, id: &str, format: Option<&str>) -> Result<String, String> {
    let meta = google
        .get_json(&format!(
            "{API}/{}?fields=id,name,mimeType,size&supportsAllDrives=true",
            encode(id)
        ))
        .await?;
    let name = meta.get("name").and_then(Value::as_str).unwrap_or("file").to_string();
    let mime = meta.get("mimeType").and_then(Value::as_str).unwrap_or("").to_string();
    let (bytes, file_name) = match export_format(&mime, format)? {
        Some((export_mime, extension)) => {
            let bytes = google
                .get_bytes(&format!("{API}/{}/export?mimeType={}", encode(id), encode(export_mime)))
                .await?;
            (bytes, format!("{}.{extension}", strip_extension(&name)))
        }
        None => {
            let bytes = google
                .get_bytes(&format!("{API}/{}?alt=media&supportsAllDrives=true", encode(id)))
                .await?;
            (bytes, name.clone())
        }
    };
    let path = store(&bytes, &file_name).map_err(|error| format!("Could not save the file: {error}"))?;
    let mut text = format!("Saved \"{name}\" as {} ({} bytes).", path.display(), bytes.len());
    if is_text(&file_name) {
        let body = String::from_utf8_lossy(&bytes);
        text.push_str("\n\nContent (untrusted):\n");
        text.push_str(&crate::text::truncate_chars(&body, PREVIEW_CHARS));
    }
    Ok(text)
}

fn strip_extension(name: &str) -> &str {
    match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() && ext.len() <= 5 => stem,
        _ => name,
    }
}

fn is_text(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    [".md", ".txt", ".csv", ".tsv", ".html", ".json"].iter().any(|ext| lower.ends_with(ext))
}

/// Content-addressed under the bridge's files dir, keeping the readable name.
fn store(bytes: &[u8], name: &str) -> std::io::Result<PathBuf> {
    let hash = sha2::Sha256::digest(bytes);
    let prefix: String = hash.iter().take(6).map(|b| format!("{b:02x}")).collect();
    let safe: String = name
        .chars()
        .map(|c| if c.is_alphanumeric() || matches!(c, '.' | '-' | '_' | ' ') { c } else { '_' })
        .collect();
    let dir = crate::pairing::files_dir().join(prefix);
    std::fs::create_dir_all(&dir)?;
    let path = dir.join(safe.trim());
    std::fs::write(&path, bytes)?;
    Ok(path)
}

/// What a local file uploads as, and what it becomes when converted.
fn upload_types(path: &Path) -> (&'static str, Option<&'static str>) {
    let ext = path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "docx" => ("application/vnd.openxmlformats-officedocument.wordprocessingml.document", Some(DOC)),
        "doc" => ("application/msword", Some(DOC)),
        "md" => ("text/markdown", Some(DOC)),
        "txt" => ("text/plain", Some(DOC)),
        "html" | "htm" => ("text/html", Some(DOC)),
        "odt" => ("application/vnd.oasis.opendocument.text", Some(DOC)),
        "xlsx" => ("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", Some(SHEET)),
        "xls" => ("application/vnd.ms-excel", Some(SHEET)),
        "csv" => ("text/csv", Some(SHEET)),
        "tsv" => ("text/tab-separated-values", Some(SHEET)),
        "ods" => ("application/vnd.oasis.opendocument.spreadsheet", Some(SHEET)),
        "pptx" => ("application/vnd.openxmlformats-officedocument.presentationml.presentation", Some(SLIDES)),
        "pdf" => ("application/pdf", None),
        "png" => ("image/png", None),
        "jpg" | "jpeg" => ("image/jpeg", None),
        _ => ("application/octet-stream", None),
    }
}

pub fn multipart(boundary: &str, metadata: &Value, mime: &str, bytes: &[u8]) -> Vec<u8> {
    let mut body = Vec::with_capacity(bytes.len() + 512);
    body.extend_from_slice(
        format!("--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{metadata}\r\n--{boundary}\r\nContent-Type: {mime}\r\n\r\n")
            .as_bytes(),
    );
    body.extend_from_slice(bytes);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    body
}

pub async fn push(
    google: &Google,
    path: &Path,
    name: Option<&str>,
    folder: Option<&str>,
    convert: bool,
) -> Result<String, String> {
    let bytes = std::fs::read(path)
        .map_err(|error| format!("Could not read {}: {error}", path.display()))?;
    let (mime, native) = upload_types(path);
    let name = name
        .map(str::to_string)
        .or_else(|| path.file_name().map(|name| name.to_string_lossy().to_string()))
        .unwrap_or_else(|| "upload".to_string());
    let mut metadata = json!({ "name": if convert && native.is_some() { strip_extension(&name).to_string() } else { name.clone() } });
    if convert {
        match native {
            Some(native) => metadata["mimeType"] = json!(native),
            None => return Err(format!("{} cannot be converted into a Google file; push it without convert", path.display())),
        }
    }
    if let Some(folder) = folder.and_then(super::file_id) {
        metadata["parents"] = json!([folder]);
    }
    let boundary = format!("agente-{}", uuid::Uuid::new_v4().simple());
    let reply = google
        .post_upload(
            &format!("{UPLOAD}?uploadType=multipart&supportsAllDrives=true&fields=id,name,mimeType,webViewLink"),
            &boundary,
            multipart(&boundary, &metadata, mime, &bytes),
        )
        .await?;
    let get = |key: &str| reply.get(key).and_then(Value::as_str).unwrap_or("").to_string();
    Ok(format!(
        "Uploaded {} as \"{}\" [{}] id={} · {}",
        path.display(),
        get("name"),
        kind_label(&get("mimeType")),
        get("id"),
        get("webViewLink")
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn find_queries_escape_what_drive_needs_escaped() {
        assert_eq!(find_query("", None), "trashed = false");
        assert_eq!(
            find_query("Bob's \\ plan", Some("sheet")),
            format!("trashed = false and name contains 'Bob\\'s \\\\ plan' and mimeType = '{SHEET}'")
        );
        assert_eq!(find_query("x", Some("whatever")), "trashed = false and name contains 'x'");
    }

    #[test]
    fn exports_default_to_office_formats_and_refuse_the_impossible() {
        assert_eq!(export_format(SHEET, None).unwrap().unwrap().1, "xlsx");
        assert_eq!(export_format(DOC, Some(".MD")).unwrap().unwrap().1, "md");
        assert_eq!(export_format(SLIDES, None).unwrap().unwrap().1, "pptx");
        assert!(export_format(SHEET, Some("docx")).unwrap_err().contains("xlsx"));
        assert!(export_format("application/pdf", Some("xlsx")).unwrap().is_none());
        assert!(export_format("application/vnd.google-apps.form", None).is_err());
    }

    #[test]
    fn uploads_know_what_they_convert_into() {
        assert_eq!(upload_types(Path::new("a/report.DOCX")).1, Some(DOC));
        assert_eq!(upload_types(Path::new("data.csv")).1, Some(SHEET));
        assert_eq!(upload_types(Path::new("photo.png")).1, None);
        assert_eq!(strip_extension("Budget 2026.xlsx"), "Budget 2026");
        assert_eq!(strip_extension(".env"), ".env");
    }

    #[test]
    fn the_multipart_body_frames_metadata_then_bytes() {
        let body = multipart("b", &json!({"name": "x"}), "text/csv", b"a,b");
        let text = String::from_utf8(body).unwrap();
        assert!(text.starts_with("--b\r\nContent-Type: application/json"));
        assert!(text.contains("{\"name\":\"x\"}\r\n--b\r\nContent-Type: text/csv\r\n\r\na,b\r\n--b--"));
    }
}
