//! A bot's daily budget: what it spent today, from the cost of each model
//! call, and whether it may start another turn.

use chrono::NaiveDate;
use serde::{Deserialize, Serialize};

use crate::{BotError, BotStore};

/// Spend on one day (the computer's local date), in US dollars.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DailySpend {
    pub day: NaiveDate,
    pub usd: f64,
}

impl BotStore {
    /// What `handle` has spent on `day`.
    pub fn spent_on(&self, handle: &str, day: NaiveDate) -> Result<f64, BotError> {
        Ok(self
            .read_state(handle)?
            .spend
            .filter(|spend| spend.day == day)
            .map_or(0.0, |spend| spend.usd))
    }

    /// Add the cost of a model call to `day`'s spend (a new day starts at zero).
    pub fn add_spend(&self, handle: &str, day: NaiveDate, usd: f64) -> Result<(), BotError> {
        if !usd.is_finite() || usd <= 0.0 {
            return Ok(());
        }
        self.edit_state(handle, |state| {
            let spent = state
                .spend
                .as_ref()
                .filter(|spend| spend.day == day)
                .map_or(0.0, |spend| spend.usd);
            state.spend = Some(DailySpend {
                day,
                usd: spent + usd,
            });
        })
    }

    /// Refuse a new turn once the bot has spent its daily budget.
    pub fn check_budget(&self, handle: &str, day: NaiveDate) -> Result<(), BotError> {
        let Some(budget) = self.get(handle)?.config.daily_budget else {
            return Ok(());
        };
        let spent = self.spent_on(handle, day)?;
        if spent >= budget {
            return Err(BotError::OverBudget {
                handle: handle.to_string(),
                spent,
                budget,
            });
        }
        Ok(())
    }

    /// The bot whose permanent session this is, if any.
    pub fn handle_for_session(&self, session_id: &str) -> Result<Option<String>, BotError> {
        for bot in self.list()? {
            if self.read_state(&bot.handle)?.session_id.as_deref() == Some(session_id) {
                return Ok(Some(bot.handle));
            }
        }
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::DEFAULT_BOT;

    fn day(d: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(2026, 9, d).unwrap()
    }

    #[test]
    fn spend_adds_up_within_a_day_and_restarts_the_next() {
        let dir = tempfile::tempdir().unwrap();
        let store = BotStore::open(dir.path()).unwrap();
        store.add_spend(DEFAULT_BOT, day(1), 0.25).unwrap();
        store.add_spend(DEFAULT_BOT, day(1), 0.5).unwrap();
        store.add_spend(DEFAULT_BOT, day(1), f64::NAN).unwrap();
        assert!((store.spent_on(DEFAULT_BOT, day(1)).unwrap() - 0.75).abs() < 1e-9);
        assert_eq!(store.spent_on(DEFAULT_BOT, day(2)).unwrap(), 0.0);
        store.add_spend(DEFAULT_BOT, day(2), 0.1).unwrap();
        assert!((store.spent_on(DEFAULT_BOT, day(2)).unwrap() - 0.1).abs() < 1e-9);
    }

    #[test]
    fn a_spent_budget_stops_new_turns_until_tomorrow() {
        let dir = tempfile::tempdir().unwrap();
        let store = BotStore::open(dir.path()).unwrap();
        // No budget: never stopped.
        store.add_spend(DEFAULT_BOT, day(1), 50.0).unwrap();
        store.check_budget(DEFAULT_BOT, day(1)).unwrap();

        let mut config = store.get(DEFAULT_BOT).unwrap().config;
        config.daily_budget = Some(1.0);
        store.update(DEFAULT_BOT, config).unwrap();
        assert!(matches!(
            store.check_budget(DEFAULT_BOT, day(1)),
            Err(BotError::OverBudget { .. })
        ));
        store.check_budget(DEFAULT_BOT, day(2)).unwrap();
    }

    #[test]
    fn sessions_map_back_to_their_bot() {
        let dir = tempfile::tempdir().unwrap();
        let store = BotStore::open(dir.path()).unwrap();
        store.set_session_id(DEFAULT_BOT, "abc").unwrap();
        assert_eq!(
            store.handle_for_session("abc").unwrap().as_deref(),
            Some(DEFAULT_BOT)
        );
        assert_eq!(store.handle_for_session("other").unwrap(), None);
    }
}
