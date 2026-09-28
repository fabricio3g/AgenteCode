//! Running bot routines: the scheduler that starts them when due, and the
//! `routines.*` methods clients manage them with. A routine's run is an
//! ordinary turn in the bot's permanent session, so its answer lands in the
//! bot's chat and every subscribed client sees it happen.

use std::time::Duration;

use agente_bot::{BotStore, NewRoutine, Routine, RoutineRun};
use agente_protocol::{Origin, StartTurn, Trust, TurnStatus};
use agente_runtime::{RuntimeError, TurnHandle};
use chrono::Utc;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::task::JoinHandle;

use crate::bots::{bot_failure, bot_turn, ClientModel};
use crate::connection::{parse, runtime_failure, Failure};
use crate::Service;

/// How often the scheduler looks for due routines.
const TICK: Duration = Duration::from_secs(30);
/// The origin channel of a routine's turn.
const ROUTINE_CHANNEL: &str = "routine";

/// Look for due routines every 30 seconds and start them.
pub fn spawn_scheduler(service: Service) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(TICK);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tick.tick().await;
            run_due(&service);
        }
    })
}

/// Start every routine that is due now.
fn run_due(service: &Service) {
    let due = match service.bots.due_routines(Utc::now()) {
        Ok(due) => due,
        Err(error) => {
            tracing::warn!(%error, "could not read routines");
            return;
        }
    };
    for (handle, routine) in due {
        match start(service, &handle, &routine) {
            Ok(turn) => follow(service.bots.clone(), handle, routine.id, turn),
            // Mid-conversation: try again on the next tick.
            Err(RuntimeError::SessionBusy(_)) => {}
            Err(error) => {
                tracing::warn!(%error, bot = handle, routine = routine.id, "routine did not start");
                record(&service.bots, &handle, &routine.id, "failed");
            }
        }
    }
}

fn routine_turn(store: &BotStore, handle: &str, routine: &Routine) -> Result<StartTurn, Failure> {
    let text = format!("Routine “{}”:\n\n{}", routine.title, routine.prompt);
    let fallback = ClientModel {
        provider: routine.model.as_ref().map(|pin| pin.provider.clone()),
        model: routine.model.as_ref().map(|pin| pin.model.clone()),
        thinking_level: None,
    };
    let origin = Origin {
        channel: ROUTINE_CHANNEL.into(),
        sender: Some(routine.id.clone()),
        trust: Trust::Owner,
    };
    bot_turn(store, handle, text, fallback, Some(origin)).map_err(bot_failure)
}

fn start(service: &Service, handle: &str, routine: &Routine) -> Result<TurnHandle, RuntimeError> {
    let start = routine_turn(&service.bots, handle, routine)
        .map_err(|(_, message)| RuntimeError::Config(message))?;
    let turn = service.runtime.start_turn(start)?;
    record(&service.bots, handle, &routine.id, "running");
    Ok(turn)
}

fn record(store: &BotStore, handle: &str, id: &str, status: &str) {
    let run = RoutineRun {
        at: Utc::now(),
        status: status.into(),
    };
    if let Err(error) = store.record_run(handle, id, run) {
        tracing::warn!(%error, bot = handle, routine = id, "could not record the routine run");
    }
}

/// Drain the run's events (its channel is bounded) and record how it ended.
fn follow(store: std::sync::Arc<BotStore>, handle: String, id: String, mut turn: TurnHandle) {
    tokio::spawn(async move {
        while let Some(envelope) = turn.recv().await {
            if envelope.event.is_terminal() {
                break;
            }
        }
        let status = match turn.outcome().await.map(|outcome| outcome.status) {
            Some(TurnStatus::Completed) => "completed",
            Some(TurnStatus::Cancelled) => "cancelled",
            _ => "failed",
        };
        // Keep the start time: the next run is due from when this one began.
        let at = store
            .last_run(&handle, &id)
            .ok()
            .flatten()
            .map_or_else(Utc::now, |run| run.at);
        let run = RoutineRun {
            at,
            status: status.into(),
        };
        if let Err(error) = store.record_run(&handle, &id, run) {
            tracing::warn!(%error, bot = handle, routine = id, "could not record the routine run");
        }
    });
}

#[derive(Deserialize)]
struct HandleParams {
    handle: String,
}

#[derive(Deserialize)]
struct SaveParams {
    handle: String,
    routine: NewRoutine,
}

#[derive(Deserialize)]
struct RoutineParams {
    handle: String,
    id: String,
}

fn describe(store: &BotStore, handle: &str, routine: &Routine) -> Result<Value, Failure> {
    let last_run = store.last_run(handle, &routine.id).map_err(bot_failure)?;
    let next_run = (!routine.paused)
        .then(|| {
            routine
                .schedule
                .next_after(last_run.as_ref().map_or(routine.created_at, |run| run.at))
        })
        .flatten();
    let mut value = serde_json::to_value(routine)
        .map_err(|e| (agente_acp::rpc::INTERNAL_ERROR, e.to_string()))?;
    value["last_run"] = json!(last_run);
    value["next_run"] = json!(next_run);
    Ok(value)
}

/// `routines.*` requests other than `routines.run_now` (which starts a turn).
pub(crate) fn handle(store: &BotStore, method: &str, params: Value) -> Result<Value, Failure> {
    match method {
        "routines.list" => {
            let HandleParams { handle } = parse(params)?;
            let routines = store.routines(&handle).map_err(bot_failure)?;
            Ok(Value::Array(
                routines
                    .iter()
                    .map(|routine| describe(store, &handle, routine))
                    .collect::<Result<_, _>>()?,
            ))
        }
        "routines.save" => {
            let SaveParams { handle, routine } = parse(params)?;
            let routine = store.save_routine(&handle, routine).map_err(bot_failure)?;
            describe(store, &handle, &routine)
        }
        "routines.delete" => {
            let RoutineParams { handle, id } = parse(params)?;
            Ok(json!({ "deleted": store.delete_routine(&handle, &id).map_err(bot_failure)? }))
        }
        _ => Err((
            agente_acp::rpc::METHOD_NOT_FOUND,
            format!("unknown method {method}"),
        )),
    }
}

/// `routines.run_now`: the routine's turn, now, streamed to the asking
/// client (which sees how it ends; the run is recorded as manual).
pub(crate) fn run_now(service: &Service, params: Value) -> Result<TurnHandle, Failure> {
    let RoutineParams { handle, id } = parse(params)?;
    let routine = service.bots.routine(&handle, &id).map_err(bot_failure)?;
    let start = routine_turn(&service.bots, &handle, &routine)?;
    let turn = service.runtime.start_turn(start).map_err(runtime_failure)?;
    record(&service.bots, &handle, &id, "manual");
    Ok(turn)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_routine_turn_runs_in_the_bots_session_as_the_owner() {
        let dir = tempfile_dir("turn");
        let store = BotStore::open(&dir).unwrap();
        let routine = store
            .save_routine(
                "colina",
                NewRoutine {
                    id: None,
                    title: "Brief".into(),
                    prompt: "What's on today?".into(),
                    schedule: agente_bot::Schedule::Day { at: "08:00".into() },
                    paused: false,
                    model: Some(agente_bot::ModelPin {
                        provider: "openrouter".into(),
                        model: "m".into(),
                    }),
                },
            )
            .unwrap();
        let turn = routine_turn(&store, "colina", &routine).unwrap();
        assert_eq!(turn.profile.as_deref(), Some("colina"));
        assert_eq!(turn.model.as_deref(), Some("m"));
        let origin = turn.origin.unwrap();
        assert_eq!(origin.channel, ROUTINE_CHANNEL);
        assert_eq!(origin.trust, Trust::Owner);
        let text = turn.prompt.unwrap().content;
        assert!(text.starts_with("Routine “Brief”:"));

        let listed = handle(&store, "routines.list", json!({ "handle": "colina" })).unwrap();
        assert_eq!(listed[0]["id"], "brief");
        assert!(listed[0]["next_run"].is_string());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn the_scheduler_starts_a_due_routine_and_records_how_it_ended() {
        use agente_core::config::AppConfig;
        use agente_runtime::{RuntimeConfig, RuntimeSupervisor};

        let dir = tempfile_dir("due");
        let bots = std::sync::Arc::new(BotStore::open(dir.join("bots")).unwrap());
        // Made two hours ago, hourly: due now. The provider fails offline.
        let created = (Utc::now() - chrono::Duration::hours(2)).to_rfc3339();
        std::fs::write(
            dir.join("bots/colina/routines.toml"),
            format!(
                "[[routine]]\nid = \"check\"\ntitle = \"Check\"\nprompt = \"Anything new?\"\n\
                 created_at = \"{created}\"\nschedule = {{ every = \"hour\", minute = 0 }}\n\
                 model = {{ provider = \"definitely-not-a-provider\", model = \"m\" }}\n"
            ),
        )
        .unwrap();
        let config = RuntimeConfig::from_app_config(&AppConfig::default(), dir.to_string_lossy());
        let service = Service {
            runtime: RuntimeSupervisor::start(config),
            bots: bots.clone(),
        };

        run_due(&service);
        assert_eq!(
            bots.last_run("colina", "check").unwrap().unwrap().status,
            "running"
        );
        // Not due again right away.
        assert!(bots.due_routines(Utc::now()).unwrap().is_empty());
        for _ in 0..50 {
            if bots.last_run("colina", "check").unwrap().unwrap().status != "running" {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert_eq!(
            bots.last_run("colina", "check").unwrap().unwrap().status,
            "failed"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    fn tempfile_dir(tag: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("agente-routines-{tag}-{}", std::process::id()))
    }
}
