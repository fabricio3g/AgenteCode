//! Session goals shared by the terminal and runtime.
//!
//! Goals are separate from transcripts: changing one must not rewrite model
//! history or turn a reminder into a permanent user message.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GoalStatus {
    Active,
    Completed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Goal {
    pub objective: String,
    pub status: GoalStatus,
}

/// One file per session, written atomically so an interrupted save keeps the
/// last complete goal. Session ids are UUIDs and cannot escape this directory.
pub struct GoalStore {
    directory: PathBuf,
}

impl GoalStore {
    pub fn new(directory: impl Into<PathBuf>) -> Self {
        Self {
            directory: directory.into(),
        }
    }

    pub fn user() -> Self {
        let sessions = std::env::var_os("AGENTE_SESSIONS_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                dirs::home_dir()
                    .unwrap_or_else(|| PathBuf::from("."))
                    .join(".agente")
                    .join("sessions")
            });
        Self::new(sessions.join("goals"))
    }

    fn path(&self, session: Uuid) -> PathBuf {
        self.directory.join(format!("{session}.json"))
    }

    pub fn get(&self, session: Uuid) -> anyhow::Result<Option<Goal>> {
        match fs::read(self.path(session)) {
            Ok(bytes) => Ok(Some(serde_json::from_slice(&bytes)?)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.into()),
        }
    }

    pub fn put(&self, session: Uuid, goal: &Goal) -> anyhow::Result<()> {
        anyhow::ensure!(!goal.objective.trim().is_empty(), "goal cannot be empty");
        anyhow::ensure!(goal.objective.len() <= 16_384, "goal is too long");
        write_atomic(
            &self.directory,
            &self.path(session),
            &serde_json::to_vec(goal)?,
        )
    }

    pub fn clear(&self, session: Uuid) -> anyhow::Result<()> {
        match fs::remove_file(self.path(session)) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.into()),
        }
    }
}

fn write_atomic(directory: &Path, path: &Path, bytes: &[u8]) -> anyhow::Result<()> {
    fs::create_dir_all(directory)?;
    let mut file = tempfile::NamedTempFile::new_in(directory)?;
    file.write_all(bytes)?;
    file.as_file_mut().sync_all()?;
    file.persist(path).map_err(|error| error.error)?;
    Ok(())
}

impl Goal {
    /// Request-only reminder; callers must never append it to saved history.
    pub fn reminder(&self) -> Option<String> {
        (self.status == GoalStatus::Active).then(|| format!(
            "Active session goal: {}\nContinue working toward this objective across turns. If it remains unfinished, say what remains; do not claim completion without evidence. When it is fully achieved, use goal_complete if available.",
            self.objective.trim()
        ))
    }
}

/// The agent can close a goal only when it still matches the one it was given.
pub struct GoalCompleteTool {
    pub session_id: Uuid,
}

#[derive(Deserialize, schemars::JsonSchema)]
pub struct GoalCompleteArgs {
    /// The exact active objective that has been fully achieved.
    objective: String,
}

impl crate::tools::ToolCore for GoalCompleteTool {
    type Args = GoalCompleteArgs;

    fn name(&self) -> &str {
        "goal_complete"
    }
    fn kind(&self) -> crate::tools::ToolKind {
        crate::tools::ToolKind::Todo
    }
    fn icon(&self) -> &'static str {
        "✓"
    }
    fn description(&self) -> &str {
        "Mark the active session goal complete only after all of it has been achieved and verified. Do not call if work remains, is blocked, or needs user input."
    }
    fn execution_mode(&self) -> crate::tools::ToolExecutionMode {
        crate::tools::ToolExecutionMode::Sequential
    }
    fn allowed_in_plan(&self) -> bool {
        false
    }

    async fn run(
        &self,
        args: GoalCompleteArgs,
        _project_dir: &str,
        _context: &crate::tools::ToolExecutionContext,
    ) -> Result<String, crate::tools::ToolError> {
        let store = GoalStore::user();
        let mut goal = store
            .get(self.session_id)
            .map_err(|e| crate::tools::ToolError::ExecutionError(e.to_string()))?
            .ok_or_else(|| {
                crate::tools::ToolError::InvalidArguments("There is no active goal".into())
            })?;
        if goal.status != GoalStatus::Active || goal.objective != args.objective {
            return Err(crate::tools::ToolError::InvalidArguments(
                "The active goal changed; do not complete an outdated goal".into(),
            ));
        }
        goal.status = GoalStatus::Completed;
        store
            .put(self.session_id, &goal)
            .map_err(|e| crate::tools::ToolError::ExecutionError(e.to_string()))?;
        Ok("Session goal completed".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn goals_are_durable_per_session_and_only_active_goals_remind() {
        let dir = tempfile::tempdir().unwrap();
        let store = GoalStore::new(dir.path());
        let session = Uuid::new_v4();
        let other = Uuid::new_v4();
        let mut goal = Goal {
            objective: "Finish the migration".into(),
            status: GoalStatus::Active,
        };
        store.put(session, &goal).unwrap();
        assert_eq!(
            GoalStore::new(dir.path()).get(session).unwrap(),
            Some(goal.clone())
        );
        assert!(store.get(other).unwrap().is_none());
        assert!(goal.reminder().unwrap().contains("Finish the migration"));
        goal.status = GoalStatus::Completed;
        store.put(session, &goal).unwrap();
        assert!(store.get(session).unwrap().unwrap().reminder().is_none());
        store.clear(session).unwrap();
        assert!(store.get(session).unwrap().is_none());
        assert!(store
            .put(
                session,
                &Goal {
                    objective: " ".into(),
                    status: GoalStatus::Active
                }
            )
            .is_err());
    }
}
