//! Routines: prompts a bot runs on a schedule, each answer landing in its
//! chat. They live in the bot's `routines.toml`; when each last ran is kept
//! in `state.json`.
//!
//! Schedules are frequency first ("every day at 08:00") and become a cron
//! expression underneath, read in local time. A routine is due when the
//! first time it should have run since its last run has passed, so a run
//! missed while the machine slept happens once on wake, not once per slot.

use chrono::{DateTime, Local, Utc};
use serde::{Deserialize, Serialize};

use crate::{BotError, BotStore, ModelPin};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "every", rename_all = "lowercase")]
pub enum Schedule {
    /// Every hour, at `minute` past.
    Hour { minute: u8 },
    /// Every day at `at` ("HH:MM").
    Day { at: String },
    /// Monday to Friday at `at`.
    Weekdays { at: String },
    /// Once a week: `day` is mon, tue, wed, thu, fri, sat or sun.
    Week { day: String, at: String },
    /// A standard five-field cron expression ("30 9 * * 1-5").
    Cron { expr: String },
}

const DAYS: [&str; 7] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

fn hour_minute(at: &str) -> Result<(u32, u32), String> {
    let invalid = || format!("{at:?} isn't a time; use HH:MM (24-hour)");
    let (hour, minute) = at.trim().split_once(':').ok_or_else(invalid)?;
    let hour: u32 = hour.parse().map_err(|_| invalid())?;
    let minute: u32 = minute.parse().map_err(|_| invalid())?;
    if hour > 23 || minute > 59 {
        return Err(invalid());
    }
    Ok((hour, minute))
}

impl Schedule {
    /// The cron expression (with seconds, as the `cron` crate reads it).
    fn expression(&self) -> Result<String, String> {
        Ok(match self {
            Schedule::Hour { minute } if *minute < 60 => format!("0 {minute} * * * *"),
            Schedule::Hour { minute } => return Err(format!("minute {minute} is past 59")),
            Schedule::Day { at } => {
                let (hour, minute) = hour_minute(at)?;
                format!("0 {minute} {hour} * * *")
            }
            Schedule::Weekdays { at } => {
                let (hour, minute) = hour_minute(at)?;
                format!("0 {minute} {hour} * * Mon-Fri")
            }
            Schedule::Week { day, at } => {
                let (hour, minute) = hour_minute(at)?;
                let day = day.trim().to_lowercase();
                let day = DAYS
                    .iter()
                    .find(|name| day.starts_with(**name))
                    .ok_or_else(|| format!("{day:?} isn't a day; use mon … sun"))?;
                format!("0 {minute} {hour} * * {day}")
            }
            Schedule::Cron { expr } => {
                if expr.split_whitespace().count() != 5 {
                    return Err(format!(
                        "{expr:?}: use five fields (minute hour day month weekday)"
                    ));
                }
                format!("0 {}", expr.trim())
            }
        })
    }

    fn parsed(&self) -> Result<cron::Schedule, String> {
        let expression = self.expression()?;
        expression
            .parse::<cron::Schedule>()
            .map_err(|error| format!("{expression}: {error}"))
    }

    /// Whether this schedule can run at all.
    pub fn validate(&self) -> Result<(), String> {
        self.parsed().map(|_| ())
    }

    /// The first time it runs after `after`, in local time.
    pub fn next_after(&self, after: DateTime<Utc>) -> Option<DateTime<Utc>> {
        let schedule = self.parsed().ok()?;
        schedule
            .after(&after.with_timezone(&Local))
            .next()
            .map(|next| next.with_timezone(&Utc))
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Routine {
    pub id: String,
    pub title: String,
    /// What the bot is asked each time.
    pub prompt: String,
    pub schedule: Schedule,
    #[serde(default)]
    pub paused: bool,
    /// The model to use when the bot pins none (the one in use when the
    /// routine was made).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<ModelPin>,
    pub created_at: DateTime<Utc>,
}

impl Routine {
    /// Due when its next time after the last run (or its creation) has come.
    pub fn is_due(&self, last_run: Option<DateTime<Utc>>, now: DateTime<Utc>) -> bool {
        !self.paused
            && self
                .schedule
                .next_after(last_run.unwrap_or(self.created_at))
                .is_some_and(|next| next <= now)
    }
}

/// A routine to create, or to change when `id` names an existing one.
#[derive(Debug, Clone, Deserialize)]
pub struct NewRoutine {
    #[serde(default)]
    pub id: Option<String>,
    pub title: String,
    pub prompt: String,
    pub schedule: Schedule,
    #[serde(default)]
    pub paused: bool,
    #[serde(default)]
    pub model: Option<ModelPin>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RoutineRun {
    pub at: DateTime<Utc>,
    /// running, completed, failed, cancelled, or manual (run by hand).
    pub status: String,
}

#[derive(Default, Serialize, Deserialize)]
struct RoutinesFile {
    #[serde(default, rename = "routine")]
    routines: Vec<Routine>,
}

impl BotStore {
    pub fn routines(&self, handle: &str) -> Result<Vec<Routine>, BotError> {
        self.get(handle)?;
        let path = self.dir(handle).join("routines.toml");
        let text = match std::fs::read_to_string(&path) {
            Ok(text) => text,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(error.into()),
        };
        let file: RoutinesFile = toml::from_str(&text).map_err(|error| BotError::Config {
            handle: handle.to_string(),
            message: format!("routines.toml: {error}"),
        })?;
        Ok(file.routines)
    }

    fn write_routines(&self, handle: &str, routines: Vec<Routine>) -> Result<(), BotError> {
        let text = toml::to_string_pretty(&RoutinesFile { routines }).map_err(|error| {
            BotError::Config {
                handle: handle.to_string(),
                message: format!("routines.toml: {error}"),
            }
        })?;
        std::fs::write(self.dir(handle).join("routines.toml"), text)?;
        Ok(())
    }

    /// Add a routine, or change the one `new.id` names (its history stays).
    pub fn save_routine(&self, handle: &str, new: NewRoutine) -> Result<Routine, BotError> {
        new.schedule.validate().map_err(BotError::Routine)?;
        if new.title.trim().is_empty() || new.prompt.trim().is_empty() {
            return Err(BotError::Routine(
                "A routine needs a title and a prompt.".into(),
            ));
        }
        let mut routines = self.routines(handle)?;
        let existing = new
            .id
            .as_deref()
            .and_then(|id| routines.iter().position(|routine| routine.id == id));
        let routine = Routine {
            id: match (&existing, new.id) {
                (Some(_), Some(id)) => id,
                _ => unique_id(&new.title, &routines),
            },
            title: new.title.trim().to_string(),
            prompt: new.prompt.trim().to_string(),
            schedule: new.schedule,
            paused: new.paused,
            model: new.model,
            created_at: existing.map_or_else(Utc::now, |index| routines[index].created_at),
        };
        match existing {
            Some(index) => routines[index] = routine.clone(),
            None => routines.push(routine.clone()),
        }
        self.write_routines(handle, routines)?;
        Ok(routine)
    }

    pub fn delete_routine(&self, handle: &str, id: &str) -> Result<bool, BotError> {
        let mut routines = self.routines(handle)?;
        let before = routines.len();
        routines.retain(|routine| routine.id != id);
        if routines.len() == before {
            return Ok(false);
        }
        self.write_routines(handle, routines)?;
        self.edit_state(handle, |state| {
            state.routines.remove(id);
        })?;
        Ok(true)
    }

    pub fn routine(&self, handle: &str, id: &str) -> Result<Routine, BotError> {
        self.routines(handle)?
            .into_iter()
            .find(|routine| routine.id == id)
            .ok_or_else(|| BotError::Routine(format!("@{handle} has no routine {id:?}")))
    }

    pub fn last_run(&self, handle: &str, id: &str) -> Result<Option<RoutineRun>, BotError> {
        Ok(self.read_state(handle)?.routines.remove(id))
    }

    pub fn record_run(&self, handle: &str, id: &str, run: RoutineRun) -> Result<(), BotError> {
        self.edit_state(handle, |state| {
            state.routines.insert(id.to_string(), run);
        })
    }

    /// Every routine of every bot that should run by `now`.
    pub fn due_routines(&self, now: DateTime<Utc>) -> Result<Vec<(String, Routine)>, BotError> {
        let mut due = Vec::new();
        for bot in self.list()? {
            let state = self.read_state(&bot.handle)?;
            // A broken routines.toml stops that bot's routines, not everyone's.
            for routine in self.routines(&bot.handle).unwrap_or_default() {
                let last_run = state.routines.get(&routine.id).map(|run| run.at);
                if routine.is_due(last_run, now) {
                    due.push((bot.handle.clone(), routine));
                }
            }
        }
        Ok(due)
    }
}

fn unique_id(title: &str, routines: &[Routine]) -> String {
    let base: String = crate::slug(title);
    let mut id = base.clone();
    let mut n = 2;
    while routines.iter().any(|routine| routine.id == id) {
        id = format!("{base}-{n}");
        n += 1;
    }
    id
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Duration, TimeZone};

    fn local(y: i32, m: u32, d: u32, h: u32, min: u32) -> DateTime<Utc> {
        Local
            .with_ymd_and_hms(y, m, d, h, min, 0)
            .single()
            .unwrap()
            .with_timezone(&Utc)
    }

    fn day_at(at: &str) -> Schedule {
        Schedule::Day { at: at.into() }
    }

    #[test]
    fn schedules_become_cron_in_local_time() {
        // 2026-09-28 is a Monday.
        let monday_7am = local(2026, 9, 28, 7, 0);
        assert_eq!(
            day_at("08:00").next_after(monday_7am),
            Some(local(2026, 9, 28, 8, 0))
        );
        assert_eq!(
            Schedule::Hour { minute: 15 }.next_after(monday_7am),
            Some(local(2026, 9, 28, 7, 15))
        );
        let friday_night = local(2026, 10, 2, 22, 0);
        assert_eq!(
            Schedule::Weekdays { at: "09:30".into() }.next_after(friday_night),
            Some(local(2026, 10, 5, 9, 30))
        );
        assert_eq!(
            Schedule::Week {
                day: "Sunday".into(),
                at: "18:00".into()
            }
            .next_after(monday_7am),
            Some(local(2026, 10, 4, 18, 0))
        );
        assert_eq!(
            Schedule::Cron {
                expr: "0 12 1 * *".into()
            }
            .next_after(monday_7am),
            Some(local(2026, 10, 1, 12, 0))
        );
    }

    #[test]
    fn bad_schedules_are_explained() {
        assert!(day_at("25:00").validate().unwrap_err().contains("HH:MM"));
        assert!(Schedule::Hour { minute: 61 }.validate().is_err());
        assert!(Schedule::Week {
            day: "someday".into(),
            at: "10:00".into()
        }
        .validate()
        .unwrap_err()
        .contains("mon"));
        assert!(Schedule::Cron { expr: "* *".into() }
            .validate()
            .unwrap_err()
            .contains("five fields"));
    }

    #[test]
    fn a_missed_run_happens_once_on_wake() {
        let created = local(2026, 9, 20, 7, 0);
        let routine = Routine {
            id: "brief".into(),
            title: "Brief".into(),
            prompt: "Summarize".into(),
            schedule: day_at("08:00"),
            paused: false,
            model: None,
            created_at: created,
        };
        // Asleep for a week: due now, once.
        let wake = local(2026, 9, 27, 12, 0);
        assert!(routine.is_due(None, wake));
        // Run at wake: not due again until tomorrow at 08:00.
        assert!(!routine.is_due(Some(wake), wake + Duration::hours(12)));
        assert!(routine.is_due(Some(wake), local(2026, 9, 28, 8, 0)));
        // Paused: never due.
        let paused = Routine {
            paused: true,
            ..routine
        };
        assert!(!paused.is_due(None, wake));
    }

    #[test]
    fn routines_are_saved_updated_and_their_runs_kept() {
        let dir = tempfile::tempdir().unwrap();
        let store = BotStore::open(dir.path()).unwrap();
        let new = |id: Option<&str>, title: &str| NewRoutine {
            id: id.map(str::to_string),
            title: title.into(),
            prompt: "What's on today?".into(),
            schedule: day_at("08:00"),
            paused: false,
            model: None,
        };
        let brief = store
            .save_routine("colina", new(None, "Morning brief"))
            .unwrap();
        assert_eq!(brief.id, "morning-brief");
        let second = store
            .save_routine("colina", new(None, "Morning brief"))
            .unwrap();
        assert_eq!(second.id, "morning-brief-2");

        let run = RoutineRun {
            at: Utc::now(),
            status: "completed".into(),
        };
        store
            .record_run("colina", "morning-brief", run.clone())
            .unwrap();
        let renamed = store
            .save_routine("colina", new(Some("morning-brief"), "Daily brief"))
            .unwrap();
        assert_eq!(renamed.id, "morning-brief");
        assert_eq!(renamed.created_at, brief.created_at);
        assert_eq!(
            store.last_run("colina", "morning-brief").unwrap(),
            Some(run)
        );
        assert_eq!(store.routines("colina").unwrap().len(), 2);

        assert!(store.delete_routine("colina", "morning-brief-2").unwrap());
        assert!(!store.delete_routine("colina", "morning-brief-2").unwrap());
        assert!(store
            .save_routine(
                "colina",
                NewRoutine {
                    schedule: day_at("nope"),
                    ..new(None, "Broken")
                }
            )
            .is_err());
    }

    #[test]
    fn due_routines_span_every_bot() {
        let dir = tempfile::tempdir().unwrap();
        let store = BotStore::open(dir.path()).unwrap();
        store
            .save_routine(
                "colina",
                NewRoutine {
                    id: None,
                    title: "Hourly".into(),
                    prompt: "Check in".into(),
                    schedule: Schedule::Hour { minute: 0 },
                    paused: false,
                    model: None,
                },
            )
            .unwrap();
        assert!(store.due_routines(Utc::now()).unwrap().is_empty());
        let later = Utc::now() + Duration::hours(2);
        let due = store.due_routines(later).unwrap();
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].0, "colina");
    }
}
