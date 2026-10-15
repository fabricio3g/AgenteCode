//! Portable causal revisions. Transport, storage, credentials and authorization
//! belong to each host. Applying a received revision never creates a local edit.

use std::collections::{BTreeMap, BTreeSet};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

pub const SCHEMA_VERSION: u16 = 1;
pub const MAX_PAYLOAD_BYTES: usize = 256 * 1024;

#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, JsonSchema,
)]
#[serde(rename_all = "snake_case")]
pub enum Space {
    Home,
    Roleplay,
}

#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, JsonSchema,
)]
#[serde(rename_all = "snake_case")]
pub enum EntityKind {
    Conversation,
    Message,
    Character,
    Persona,
    World,
    Memory,
    Attachment,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct EntityKey {
    pub space: Space,
    pub kind: EntityKind,
    pub id: Uuid,
}

/// Parents describe causality, independent of device clocks. `None` is a
/// tombstone, which survives synchronization just like an ordinary revision.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Revision {
    pub schema_version: u16,
    pub id: Uuid,
    pub device_id: Uuid,
    pub entity: EntityKey,
    pub parents: BTreeSet<Uuid>,
    pub content: Option<Value>,
}

impl Revision {
    pub fn new(
        device_id: Uuid,
        entity: EntityKey,
        parents: impl IntoIterator<Item = Uuid>,
        content: Option<Value>,
    ) -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            id: Uuid::new_v4(),
            device_id,
            entity,
            parents: parents.into_iter().collect(),
            content,
        }
    }
}

#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum SyncError {
    #[error("Unsupported synchronization schema {0}")]
    Schema(u16),
    #[error("Revision exceeds the metadata size limit; transfer attachments separately")]
    TooLarge,
    #[error("Revision IDs must be non-nil and a revision cannot parent itself")]
    InvalidIdentity,
    #[error("The revision ID already belongs to different content")]
    Collision,
    #[error("Missing parent revision {0}; synchronize dependencies first")]
    MissingParent(Uuid),
    #[error("A parent revision belongs to another entity")]
    ForeignParent,
    #[error("This entity is not allowed in the selected space")]
    InvalidSpace,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApplyResult {
    Applied,
    Duplicate,
}

/// A materialized revision graph. Hosts persist revisions transactionally with
/// their entity records/outbox, then rebuild this index after process death.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Replica {
    revisions: BTreeMap<Uuid, Revision>,
    heads: BTreeMap<EntityKey, BTreeSet<Uuid>>,
}

impl Replica {
    pub fn apply(&mut self, revision: Revision) -> Result<ApplyResult, SyncError> {
        if revision.schema_version != SCHEMA_VERSION {
            return Err(SyncError::Schema(revision.schema_version));
        }
        if revision.id.is_nil()
            || revision.device_id.is_nil()
            || revision.entity.id.is_nil()
            || revision.parents.contains(&revision.id)
        {
            return Err(SyncError::InvalidIdentity);
        }
        if revision.entity.space == Space::Home
            && matches!(
                revision.entity.kind,
                EntityKind::Character
                    | EntityKind::Persona
                    | EntityKind::World
                    | EntityKind::Memory
            )
        {
            return Err(SyncError::InvalidSpace);
        }
        if serde_json::to_vec(&revision)
            .map_err(|_| SyncError::TooLarge)?
            .len()
            > MAX_PAYLOAD_BYTES
        {
            return Err(SyncError::TooLarge);
        }
        if let Some(existing) = self.revisions.get(&revision.id) {
            return if existing == &revision {
                Ok(ApplyResult::Duplicate)
            } else {
                Err(SyncError::Collision)
            };
        }
        for parent in &revision.parents {
            let previous = self
                .revisions
                .get(parent)
                .ok_or(SyncError::MissingParent(*parent))?;
            if previous.entity != revision.entity {
                return Err(SyncError::ForeignParent);
            }
        }
        let heads = self.heads.entry(revision.entity.clone()).or_default();
        for parent in &revision.parents {
            heads.remove(parent);
        }
        heads.insert(revision.id);
        self.revisions.insert(revision.id, revision);
        Ok(ApplyResult::Applied)
    }

    /// All visible alternatives. More than one head is a conflict, including
    /// delete-versus-edit conflicts; the host must retain each alternative.
    pub fn heads(&self, entity: &EntityKey) -> Vec<&Revision> {
        self.heads
            .get(entity)
            .into_iter()
            .flatten()
            .filter_map(|id| self.revisions.get(id))
            .collect()
    }

    /// Atomic batch import, accepting a sender's dependency order or an
    /// unordered snapshot. Invalid/missing dependencies leave the replica intact.
    pub fn apply_batch(&mut self, revisions: Vec<Revision>) -> Result<usize, SyncError> {
        let mut candidate = self.clone();
        let mut pending = revisions;
        let mut applied = 0;
        while !pending.is_empty() {
            let mut remaining = Vec::new();
            let mut missing = None;
            let mut progressed = false;
            for revision in pending {
                match candidate.apply(revision.clone()) {
                    Ok(result) => {
                        progressed = true;
                        applied += usize::from(result == ApplyResult::Applied);
                    }
                    Err(SyncError::MissingParent(id)) => {
                        missing = Some(id);
                        remaining.push(revision);
                    }
                    Err(error) => return Err(error),
                }
            }
            if !progressed {
                return Err(SyncError::MissingParent(
                    missing.expect("pending revisions are missing a parent"),
                ));
            }
            pending = remaining;
        }
        *self = candidate;
        Ok(applied)
    }

    pub fn revisions(&self) -> impl Iterator<Item = &Revision> {
        self.revisions.values()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn root() -> Revision {
        Revision::new(
            Uuid::new_v4(),
            EntityKey {
                space: Space::Roleplay,
                kind: EntityKind::Character,
                id: Uuid::new_v4(),
            },
            [],
            Some(json!({"name": "Mira", "greeting": "Hello, {{user}}"})),
        )
    }

    fn edit(parent: &Revision, content: Option<Value>) -> Revision {
        Revision::new(Uuid::new_v4(), parent.entity.clone(), [parent.id], content)
    }

    #[test]
    fn offline_edits_converge_without_losing_either_version() {
        let initial = root();
        let phone = edit(&initial, Some(json!({"name": "Phone edit"})));
        let desktop = edit(&initial, Some(json!({"name": "Desktop edit"})));
        let mut a = Replica::default();
        let mut b = Replica::default();
        a.apply_batch(vec![phone.clone(), initial.clone(), desktop.clone()])
            .unwrap();
        b.apply_batch(vec![desktop, initial.clone(), phone])
            .unwrap();
        assert_eq!(a, b);
        assert_eq!(a.heads(&initial.entity).len(), 2);
    }

    #[test]
    fn duplicate_delivery_does_not_create_a_new_revision() {
        let initial = root();
        let mut replica = Replica::default();
        assert_eq!(replica.apply(initial.clone()), Ok(ApplyResult::Applied));
        assert_eq!(replica.apply(initial), Ok(ApplyResult::Duplicate));
        assert_eq!(replica.revisions().count(), 1);
    }

    #[test]
    fn deletion_survives_a_stale_device_and_preserves_concurrent_edits() {
        let initial = root();
        let deleted = edit(&initial, None);
        let changed = edit(&initial, Some(json!({"name": "Keep this edit"})));
        let mut replica = Replica::default();
        replica
            .apply_batch(vec![initial.clone(), deleted.clone(), initial.clone()])
            .unwrap();
        assert_eq!(replica.heads(&initial.entity), vec![&deleted]);
        replica.apply(changed).unwrap();
        assert_eq!(replica.heads(&initial.entity).len(), 2);
        assert!(replica
            .heads(&initial.entity)
            .iter()
            .any(|r| r.content.is_none()));
    }

    #[test]
    fn resolution_supersedes_all_conflicting_heads() {
        let initial = root();
        let a = edit(&initial, Some(json!("a")));
        let b = edit(&initial, Some(json!("b")));
        let resolution = Revision::new(
            Uuid::new_v4(),
            initial.entity.clone(),
            [a.id, b.id],
            Some(json!("resolved")),
        );
        let mut replica = Replica::default();
        replica
            .apply_batch(vec![resolution.clone(), a, b, initial.clone()])
            .unwrap();
        assert_eq!(replica.heads(&initial.entity), vec![&resolution]);
    }

    #[test]
    fn failed_batch_is_atomic() {
        let initial = root();
        let missing = edit(&root(), None);
        let mut replica = Replica::default();
        assert!(matches!(
            replica.apply_batch(vec![initial, missing]),
            Err(SyncError::MissingParent(_))
        ));
        assert_eq!(replica, Replica::default());
    }

    #[test]
    fn foreign_parents_and_revision_id_collisions_are_rejected() {
        let initial = root();
        let mut replica = Replica::default();
        replica.apply(initial.clone()).unwrap();
        let mut collision = initial.clone();
        collision.content = None;
        assert_eq!(replica.apply(collision), Err(SyncError::Collision));
        let mut foreign = edit(&initial, None);
        foreign.entity.id = Uuid::new_v4();
        assert_eq!(replica.apply(foreign), Err(SyncError::ForeignParent));
    }

    #[test]
    fn future_schemas_and_oversized_metadata_are_rejected() {
        let mut revision = root();
        let mut replica = Replica::default();
        revision.schema_version += 1;
        assert_eq!(replica.apply(revision.clone()), Err(SyncError::Schema(2)));
        revision.schema_version = SCHEMA_VERSION;
        revision.content = Some(json!("x".repeat(MAX_PAYLOAD_BYTES)));
        assert_eq!(replica.apply(revision), Err(SyncError::TooLarge));
    }
}
