use std::fs::{File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_LOG_BYTES: u64 = 8 * 1024 * 1024;
const LOG_SEGMENTS: u8 = 4;

/// A bounded log for one process. Each process owns its files so concurrent
/// TUI and headless runs cannot interleave records or rotate each other's logs.
#[derive(Clone)]
pub(crate) struct LogFile(Arc<Mutex<RunLog>>);

struct RunLog {
    dir: PathBuf,
    name: String,
    segment: u8,
    bytes: u64,
    max_bytes: u64,
    file: File,
}

impl LogFile {
    pub(crate) fn open(dir: &Path) -> io::Result<(Self, PathBuf)> {
        Self::open_with_limit(dir, MAX_LOG_BYTES)
    }

    fn open_with_limit(dir: &Path, max_bytes: u64) -> io::Result<(Self, PathBuf)> {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let name = format!("agente-{nanos}-{}", std::process::id());
        let path = dir.join(format!("{name}-0.log"));
        let file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&path)?;
        Ok((
            Self(Arc::new(Mutex::new(RunLog {
                dir: dir.to_path_buf(),
                name,
                segment: 0,
                bytes: 0,
                max_bytes,
                file,
            }))),
            path,
        ))
    }
}

impl Write for LogFile {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let mut log = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if log.bytes > 0 && log.bytes.saturating_add(buf.len() as u64) > log.max_bytes {
            log.segment = (log.segment + 1) % LOG_SEGMENTS;
            let path = log.dir.join(format!("{}-{}.log", log.name, log.segment));
            log.file = OpenOptions::new()
                .create(true)
                .truncate(true)
                .write(true)
                .open(path)?;
            log.bytes = 0;
        }
        let written = log.file.write(buf)?;
        log.bytes += written as u64;
        Ok(written)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .file
            .flush()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wraps_only_this_runs_segments() {
        let dir = tempfile::tempdir().unwrap();
        let (mut writer, first_path) = LogFile::open_with_limit(dir.path(), 12).unwrap();
        let unrelated = dir.path().join("agente.log");
        std::fs::write(&unrelated, "previous run").unwrap();
        for index in 0..6 {
            writer
                .write_all(format!("record {index:02}\n").as_bytes())
                .unwrap();
        }
        assert_eq!(std::fs::read_to_string(unrelated).unwrap(), "previous run");
        assert_eq!(std::fs::read_to_string(first_path).unwrap(), "record 04\n");
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 5);
    }
}
