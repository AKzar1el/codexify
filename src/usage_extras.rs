//! Presentation-only milestones. No interaction with chat delivery or goal locks.
use crate::{
    markdown_chat::ExtrasConfig,
    types::AppConfig,
    usage_analytics::{Dashboard, Totals},
};
use chrono::{Datelike, NaiveDate};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
};

static LOCK: Mutex<()> = Mutex::new(());
const MAX_BYTES: u64 = 8 * 1024 * 1024;
#[derive(Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
struct Ledger {
    initialized: bool,
    records: BTreeMap<String, Record>,
    celebrated: BTreeSet<String>,
    earned: BTreeSet<String>,
    pending: BTreeMap<String, Notice>,
    recaps: BTreeSet<String>,
    streak_days: BTreeSet<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Record {
    pub metric: String,
    pub value: u64,
    entity: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Notice {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub detail: String,
    at: u64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Badge {
    pub id: String,
    pub title: String,
    pub detail: String,
    pub target: u64,
    pub progress: u64,
    pub earned: bool,
    pub color: &'static str,
    pub symbol: &'static str,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Week {
    pub id: String,
    pub start: String,
    pub end: String,
    pub totals: Totals,
    pub activity: Vec<u64>,
    pub active_days: usize,
    pub ready: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Snapshot {
    pub preferences: ExtrasConfig,
    pub streak: usize,
    pub best_streak: usize,
    pub active_today: bool,
    pub today: String,
    pub timezone: String,
    pub records: Vec<Record>,
    pub badges: Vec<Badge>,
    pub week: Week,
    pub notices: Vec<Notice>,
}
fn token(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}
fn ledger_path(config: &AppConfig) -> PathBuf {
    config
        .loaded_config_path
        .as_ref()
        .and_then(|p| p.parent())
        .map(Path::to_path_buf)
        .unwrap_or_else(|| crate::memory::memory_dir(config))
        .join("statistics-extras.json")
}
fn read_ledger(path: &Path) -> Result<Ledger, String> {
    let Some(bytes) = crate::usage_analytics::read(path, MAX_BYTES)
        .map_err(|_| "Cannot read statistics milestones")?
    else {
        return Ok(Ledger::default());
    };
    serde_json::from_slice(&bytes).map_err(|_| "Cannot read statistics milestones".into())
}
fn save(path: &Path, value: &Ledger) -> Result<(), String> {
    if std::fs::symlink_metadata(path).is_ok_and(|m| !m.is_file() || m.file_type().is_symlink()) {
        return Err("Invalid milestone file".into());
    }
    let bytes = serde_json::to_vec(value).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err("Milestone storage limit reached".into());
    }
    let parent = path.parent().ok_or("Invalid milestone directory")?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let mut temp = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    temp.write_all(&bytes).map_err(|e| e.to_string())?;
    temp.persist(path).map_err(|e| e.to_string())?;
    Ok(())
}
fn day_totals(d: &crate::usage_analytics::Daily) -> Totals {
    let mut t = Totals::default();
    for v in d.models.values() {
        t.add(v);
    }
    t
}
fn allowed(kind: &str, p: &ExtrasConfig) -> bool {
    match kind {
        "achievement" => p.achievements,
        "record" => p.personal_records,
        "streak" => p.daily_streaks,
        _ => false,
    }
}
fn detail(metric: &str, value: u64) -> String {
    match metric {
        "goalActiveMs" => format!(
            "{}h {}m of active goal time",
            value / 3_600_000,
            value / 60_000 % 60
        ),
        "conversationTurns" => format!("{value} turns in one conversation"),
        "conversationTools" => format!("{value} tools in one conversation"),
        "goalTurns" => format!("{value} turns on one goal"),
        _ => format!("{value} turns in one day"),
    }
}
fn record(ledger: &mut Ledger, metric: &str, entity: &str, value: u64, now: u64, p: &ExtrasConfig) {
    if value == 0 || ledger.records.get(metric).is_some_and(|r| r.value >= value) {
        return;
    }
    ledger.records.insert(
        metric.into(),
        Record {
            metric: metric.into(),
            entity: entity.into(),
            value,
        },
    );
    // Entity identity intentionally excludes goal status/revision: pause, resume,
    // edits, reloads and a further rise in the same record never celebrate twice.
    let id = token(&format!("{metric}:{entity}"));
    if ledger.celebrated.insert(id.clone()) && ledger.initialized && p.personal_records {
        ledger.pending.insert(
            id.clone(),
            Notice {
                id,
                kind: "record".into(),
                title: "Personal best!".into(),
                detail: detail(metric, value),
                at: now,
            },
        );
    }
}
fn build(
    ledger: &mut Ledger,
    d: &Dashboard,
    chats: &[(String, PathBuf)],
    p: ExtrasConfig,
    now: u64,
) -> Result<Snapshot, String> {
    let today = NaiveDate::parse_from_str(&d.today, "%Y-%m-%d")
        .map_err(|_| "Statistics date unavailable")?;
    let mut active = BTreeSet::new();
    for day in &d.daily {
        let t = day_totals(day);
        if t != Totals::default() {
            active.insert(day.date.clone());
        }
        record(ledger, "dailyTurns", &day.date, t.turns, now, &p);
    }
    for c in &d.conversations {
        record(ledger, "conversationTurns", &c.id, c.totals.turns, now, &p);
        record(
            ledger,
            "conversationTools",
            &c.id,
            c.totals.tool_calls,
            now,
            &p,
        );
    }
    for (id, path) in chats {
        let Ok(Some(bytes)) =
            crate::usage_analytics::read(&path.with_file_name("automation.json"), 1024 * 1024)
        else {
            continue;
        };
        let Ok(state) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
            continue;
        };
        let Some(goal) = state.get("goal").and_then(|v| v.as_object()) else {
            continue;
        };
        let Some(created) = goal.get("createdAtMs").and_then(|v| v.as_u64()) else {
            continue;
        };
        let entity = format!("{id}:{created}");
        let n = |key: &str| goal.get(key).and_then(|v| v.as_u64());
        let running = goal.get("status").and_then(|v| v.as_str()) == Some("active");
        let extra = if running {
            n("activeSinceMs").map_or(0, |since| {
                now.min(n("timerUntilMs").unwrap_or(since))
                    .saturating_sub(since)
            })
        } else {
            0
        };
        record(
            ledger,
            "goalActiveMs",
            &entity,
            n("elapsedActiveMs").unwrap_or(0).saturating_add(extra),
            now,
            &p,
        );
        record(
            ledger,
            "goalTurns",
            &entity,
            n("turnCount").unwrap_or(1),
            now,
            &p,
        );
    }
    let mut best = 0;
    let mut run = 0;
    let mut previous: Option<NaiveDate> = None;
    for day in &active {
        let Ok(date) = NaiveDate::parse_from_str(day, "%Y-%m-%d") else {
            continue;
        };
        run = if previous.and_then(|p| p.succ_opt()) == Some(date) {
            run + 1
        } else {
            1
        };
        best = best.max(run);
        previous = Some(date);
    }
    let active_today = active.contains(&d.today);
    if active_today
        && ledger.streak_days.insert(d.today.clone())
        && ledger.initialized
        && p.daily_streaks
    {
        let id = token(&format!("streak:{}", d.today));
        ledger.pending.insert(
            id.clone(),
            Notice {
                id,
                kind: "streak".into(),
                title: if d.streak > 1 {
                    format!("{}-day streak!", d.streak)
                } else {
                    "A little momentum".into()
                },
                detail: "Another day of building. Nice work.".into(),
                at: now,
            },
        );
    }
    // Use discovery receipts in the existing ledger so older versions can still
    // read it. Existing badges keep normal unlocks; new historical badges are quiet.
    if ledger.celebrated.insert(token("achievement-catalog:v1")) && ledger.initialized {
        ledger.celebrated.extend(
            [
                "first-goal",
                "ten-goals",
                "ten-turns",
                "hundred-turns",
                "thousand-tools",
                "ten-thousand-tools",
                "three-days",
                "seven-days",
            ]
            .into_iter()
            .map(|id| token(&format!("badge-seen:{id}"))),
        );
    }
    let goal_active_hours = ledger
        .records
        .get("goalActiveMs")
        .map_or(0, |r| r.value / 3_600_000);
    let conversation_turns = ledger
        .records
        .get("conversationTurns")
        .map_or(0, |r| r.value);
    let definitions = [
        (
            "first-goal",
            "First finish",
            "Complete a goal",
            d.lifetime.goals,
            1,
            "mint",
            "flag",
        ),
        (
            "ten-goals",
            "Finishing streak",
            "Complete 10 goals",
            d.lifetime.goals,
            10,
            "violet",
            "flag",
        ),
        (
            "twenty-five-goals",
            "Follow through",
            "Complete 25 goals",
            d.lifetime.goals,
            25,
            "sky",
            "flag",
        ),
        (
            "hundred-goals",
            "Century of finishes",
            "Complete 100 goals",
            d.lifetime.goals,
            100,
            "pink",
            "flag",
        ),
        (
            "five-hundred-goals",
            "Finishing machine",
            "Complete 500 goals",
            d.lifetime.goals,
            500,
            "amber",
            "flag",
        ),
        (
            "thousand-goals",
            "A thousand victories",
            "Complete 1,000 goals",
            d.lifetime.goals,
            1000,
            "violet",
            "flag",
        ),
        (
            "ten-turns",
            "Getting going",
            "Send 10 turns",
            d.lifetime.turns,
            10,
            "sky",
            "spark",
        ),
        (
            "hundred-turns",
            "In the groove",
            "Send 100 turns",
            d.lifetime.turns,
            100,
            "pink",
            "spark",
        ),
        (
            "five-hundred-turns",
            "Finding a rhythm",
            "Send 500 turns",
            d.lifetime.turns,
            500,
            "mint",
            "spark",
        ),
        (
            "thousand-turns",
            "A thousand ideas",
            "Send 1,000 turns",
            d.lifetime.turns,
            1000,
            "amber",
            "spark",
        ),
        (
            "ten-thousand-turns",
            "Long game",
            "Send 10,000 turns",
            d.lifetime.turns,
            10000,
            "violet",
            "spark",
        ),
        (
            "hundred-thousand-turns",
            "Beyond the horizon",
            "Send 100,000 turns",
            d.lifetime.turns,
            100000,
            "pink",
            "spark",
        ),
        (
            "thousand-tools",
            "Toolsmith",
            "Run 1,000 tools",
            d.lifetime.tool_calls,
            1000,
            "amber",
            "bolt",
        ),
        (
            "ten-thousand-tools",
            "Power builder",
            "Run 10,000 tools",
            d.lifetime.tool_calls,
            10000,
            "violet",
            "bolt",
        ),
        (
            "hundred-thousand-tools",
            "Master builder",
            "Run 100,000 tools",
            d.lifetime.tool_calls,
            100000,
            "sky",
            "bolt",
        ),
        (
            "million-tools",
            "Million-tool club",
            "Run 1,000,000 tools",
            d.lifetime.tool_calls,
            1000000,
            "mint",
            "bolt",
        ),
        (
            "five-million-tools",
            "Industrial scale",
            "Run 5,000,000 tools",
            d.lifetime.tool_calls,
            5000000,
            "pink",
            "bolt",
        ),
        (
            "ten-million-tools",
            "Ten-million league",
            "Run 10,000,000 tools",
            d.lifetime.tool_calls,
            10000000,
            "violet",
            "bolt",
        ),
        (
            "three-days",
            "Three's a streak",
            "Be active on 3 consecutive days",
            best as u64,
            3,
            "amber",
            "flame",
        ),
        (
            "seven-days",
            "A week of momentum",
            "Be active on 7 consecutive days",
            best as u64,
            7,
            "pink",
            "flame",
        ),
        (
            "thirty-days",
            "A month of momentum",
            "Be active on 30 consecutive days",
            best as u64,
            30,
            "mint",
            "flame",
        ),
        (
            "hundred-days",
            "Hundred-day fire",
            "Be active on 100 consecutive days",
            best as u64,
            100,
            "sky",
            "flame",
        ),
        (
            "one-eighty-days",
            "Staying power",
            "Be active on 180 consecutive days",
            best as u64,
            180,
            "violet",
            "flame",
        ),
        (
            "year-streak",
            "A year of momentum",
            "Be active on 365 consecutive days",
            best as u64,
            365,
            "amber",
            "flame",
        ),
        (
            "six-hour-goal",
            "Deep focus",
            "Reach 6 active hours on one goal",
            goal_active_hours,
            6,
            "sky",
            "trophy",
        ),
        (
            "day-goal",
            "Day by day",
            "Reach 24 active hours on one goal",
            goal_active_hours,
            24,
            "mint",
            "trophy",
        ),
        (
            "three-day-goal",
            "Endurance",
            "Reach 72 active hours on one goal",
            goal_active_hours,
            72,
            "pink",
            "trophy",
        ),
        (
            "week-goal",
            "Marathon",
            "Reach 168 active hours on one goal",
            goal_active_hours,
            168,
            "violet",
            "trophy",
        ),
        (
            "hundred-turn-chat",
            "Keep the thread",
            "Send 100 turns in one conversation",
            conversation_turns,
            100,
            "mint",
            "spark",
        ),
        (
            "five-hundred-turn-chat",
            "An ongoing story",
            "Send 500 turns in one conversation",
            conversation_turns,
            500,
            "sky",
            "spark",
        ),
        (
            "thousand-turn-chat",
            "Epic conversation",
            "Send 1,000 turns in one conversation",
            conversation_turns,
            1000,
            "pink",
            "spark",
        ),
        (
            "five-thousand-turn-chat",
            "The long haul",
            "Send 5,000 turns in one conversation",
            conversation_turns,
            5000,
            "violet",
            "spark",
        ),
    ];
    let badges = definitions
        .into_iter()
        .map(
            |(id, title, description, progress, target, color, symbol)| {
                let known = !ledger.celebrated.insert(token(&format!("badge-seen:{id}")));
                let earned = progress >= target;
                if earned
                    && ledger.earned.insert(id.into())
                    && known
                    && ledger.initialized
                    && p.achievements
                {
                    let event_id = token(&format!("badge:{id}"));
                    ledger.pending.insert(
                        event_id.clone(),
                        Notice {
                            id: event_id,
                            kind: "achievement".into(),
                            title: format!("Unlocked: {title}"),
                            detail: description.into(),
                            at: now,
                        },
                    );
                }
                Badge {
                    id: id.into(),
                    title: title.into(),
                    detail: description.into(),
                    target,
                    progress: if ledger.earned.contains(id) {
                        target
                    } else {
                        progress.min(target)
                    },
                    earned: ledger.earned.contains(id),
                    color,
                    symbol,
                }
            },
        )
        .collect();
    // A completed calendar week, Monday through Sunday, in the same server
    // timezone as usage counters. Never replace it with a rolling seven days.
    let end = today - chrono::Duration::days(i64::from(today.weekday().num_days_from_monday()) + 1);
    let start = end - chrono::Duration::days(6);
    let mut week_totals = Totals::default();
    let mut activity = vec![0; 7];
    let mut week_days = 0;
    for day in &d.daily {
        if day.date >= start.to_string() && day.date <= end.to_string() {
            let total = day_totals(day);
            if total != Totals::default() {
                week_days += 1;
            }
            if let Ok(date) = NaiveDate::parse_from_str(&day.date, "%Y-%m-%d") {
                activity[(date - start).num_days() as usize] = total.turns;
            }
            week_totals.add(&total);
        }
    }
    let week_id = format!("week:{end}");
    let ready =
        p.weekly_recap && week_totals != Totals::default() && !ledger.recaps.contains(&week_id);
    if !p.weekly_recap {
        ledger.recaps.insert(week_id.clone());
    }
    ledger.initialized = true;
    ledger
        .pending
        .retain(|_, n| now.saturating_sub(n.at) < 5 * 60_000 && allowed(&n.kind, &p));
    // Keep bounded date indexes; old recaps can never become the latest week again.
    let oldest = (today - chrono::Duration::days(400)).to_string();
    ledger.streak_days.retain(|d| d >= &oldest);
    ledger
        .recaps
        .retain(|id| id.as_str() >= format!("week:{oldest}").as_str());
    Ok(Snapshot {
        preferences: p,
        streak: d.streak,
        best_streak: best,
        active_today,
        today: d.today.clone(),
        timezone: d.timezone.clone(),
        records: ledger.records.values().cloned().collect(),
        badges,
        week: Week {
            id: week_id,
            start: start.to_string(),
            end: end.to_string(),
            totals: week_totals,
            activity,
            active_days: week_days,
            ready,
        },
        notices: ledger.pending.values().cloned().collect(),
    })
}
pub(crate) fn snapshot(
    config: &AppConfig,
    chats: Vec<(String, PathBuf)>,
    now: u64,
) -> Result<Snapshot, String> {
    let preferences = crate::global_settings::extras(config)?;
    let dashboard =
        crate::usage_analytics::dashboard(chats.clone(), None, now, &Default::default());
    let _guard = LOCK.lock().map_err(|_| "Milestone lock unavailable")?;
    let path = ledger_path(config);
    let mut ledger = read_ledger(&path)?;
    let result = build(&mut ledger, &dashboard, &chats, preferences, now)?;
    save(&path, &ledger)?;
    Ok(result)
}
pub(crate) fn claim(config: &AppConfig, id: &str) -> Result<bool, String> {
    if !(id
        .strip_prefix("week:")
        .is_some_and(|date| NaiveDate::parse_from_str(date, "%Y-%m-%d").is_ok())
        || id.len() == 64 && id.bytes().all(|c| c.is_ascii_hexdigit()))
    {
        return Err("Invalid milestone identity".into());
    }
    let _guard = LOCK.lock().map_err(|_| "Milestone lock unavailable")?;
    let path = ledger_path(config);
    let mut ledger = read_ledger(&path)?;
    let preferences = crate::global_settings::extras(config)?;
    let (changed, permitted) = if id.starts_with("week:") {
        (ledger.recaps.insert(id.into()), preferences.weekly_recap)
    } else if let Some(notice) = ledger.pending.remove(id) {
        (true, allowed(&notice.kind, &preferences))
    } else {
        (false, false)
    };
    if changed {
        save(&path, &ledger)?;
    }
    Ok(changed && permitted)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::usage_analytics::{Conversation, Daily};
    fn data(today: &str) -> Dashboard {
        Dashboard {
            today: today.into(),
            timezone: "UTC".into(),
            ..Default::default()
        }
    }
    fn day(date: &str, turns: u64) -> Daily {
        Daily {
            date: date.into(),
            models: BTreeMap::from([(
                "gpt-5.6-sol\u{1f}max".into(),
                Totals {
                    turns,
                    ..Default::default()
                },
            )]),
        }
    }
    fn conversation(id: &str, turns: u64) -> Conversation {
        Conversation {
            id: id.into(),
            totals: Totals {
                turns,
                ..Default::default()
            },
        }
    }
    fn record_value(snapshot: &Snapshot, metric: &str) -> u64 {
        snapshot
            .records
            .iter()
            .find(|r| r.metric == metric)
            .map_or(0, |r| r.value)
    }
    #[test]
    fn historical_baseline_is_quiet_but_new_records_survive_reload_and_keep_rising_without_replay()
    {
        let preferences = ExtrasConfig {
            achievements: false,
            ..Default::default()
        };
        let mut ledger = Ledger::default();
        let mut d = data("2026-10-18");
        d.conversations = vec![conversation("first", 10)];
        assert!(
            build(&mut ledger, &d, &[], preferences.clone(), 100)
                .unwrap()
                .notices
                .is_empty()
        );
        d.conversations.push(conversation("second", 11));
        let s = build(&mut ledger, &d, &[], preferences.clone(), 101).unwrap();
        assert_eq!(s.notices.len(), 1);
        ledger.pending.clear();
        ledger = serde_json::from_slice(&serde_json::to_vec(&ledger).unwrap()).unwrap();
        d.conversations[1].totals.turns = 500;
        let s = build(&mut ledger, &d, &[], preferences.clone(), 102).unwrap();
        assert!(s.notices.is_empty());
        assert_eq!(record_value(&s, "conversationTurns"), 500);
        d.conversations[0].totals.turns = 501;
        assert!(
            build(&mut ledger, &d, &[], preferences.clone(), 103)
                .unwrap()
                .notices
                .is_empty(),
            "initial record holder was already celebrated by baseline"
        );
        d.conversations.push(conversation("third", 502));
        assert_eq!(
            build(&mut ledger, &d, &[], preferences.clone(), 104)
                .unwrap()
                .notices
                .len(),
            1
        );
    }
    #[test]
    fn goal_pause_resume_and_edit_never_replay_record_and_use_active_time() {
        let temp = tempfile::tempdir().unwrap();
        let chat = temp.path().join("CHAT.md");
        let path = chat.with_file_name("automation.json");
        let goal = |created, revision, elapsed, since, until, state| serde_json::json!({"goal":{"createdAtMs":created,"revision":revision,"elapsedActiveMs":elapsed,"activeSinceMs":since,"timerUntilMs":until,"status":state,"turnCount":1}});
        let mut ledger = Ledger::default();
        let d = data("2026-10-18");
        let chats = vec![("chat".into(), chat)];
        std::fs::write(&path, goal(1, 1, 100, 0, 100, "active").to_string()).unwrap();
        build(&mut ledger, &d, &chats, ExtrasConfig::default(), 100).unwrap();
        std::fs::write(&path, goal(2, 2, 200, 200, 250, "active").to_string()).unwrap();
        let s = build(&mut ledger, &d, &chats, ExtrasConfig::default(), 10000).unwrap();
        assert_eq!(record_value(&s, "goalActiveMs"), 250);
        assert_eq!(s.notices.iter().filter(|n| n.kind == "record").count(), 1);
        ledger.pending.clear();
        std::fs::write(&path, goal(2, 3, 250, 0, 0, "blocked").to_string()).unwrap();
        assert!(
            build(&mut ledger, &d, &chats, ExtrasConfig::default(), 11000)
                .unwrap()
                .notices
                .is_empty()
        );
        ledger = serde_json::from_slice(&serde_json::to_vec(&ledger).unwrap()).unwrap();
        std::fs::write(&path, goal(2, 4, 250, 12000, 13000, "active").to_string()).unwrap();
        let s = build(&mut ledger, &d, &chats, ExtrasConfig::default(), 50000).unwrap();
        assert!(s.notices.is_empty());
        assert_eq!(record_value(&s, "goalActiveMs"), 1250);
    }
    #[test]
    fn achievement_catalog_has_32_distinct_badges_with_long_term_targets() {
        let mut ledger = Ledger::default();
        let mut d = data("2026-10-18");
        d.lifetime = Totals {
            goals: 1_000,
            turns: 100_000,
            tool_calls: 10_000_000,
            ..Default::default()
        };
        d.conversations = vec![conversation("long-running", 5_000)];
        let today = NaiveDate::parse_from_str(&d.today, "%Y-%m-%d").unwrap();
        d.daily = (0..365)
            .map(|n| day(&(today - chrono::Duration::days(n)).to_string(), 1))
            .collect();
        d.streak = 365;
        ledger.records.insert(
            "goalActiveMs".into(),
            Record {
                metric: "goalActiveMs".into(),
                entity: "long-goal".into(),
                value: 168 * 3_600_000,
            },
        );
        let s = build(&mut ledger, &d, &[], ExtrasConfig::default(), 1).unwrap();
        assert_eq!(s.badges.len(), 32);
        assert_eq!(
            s.badges
                .iter()
                .map(|b| &b.id)
                .collect::<BTreeSet<_>>()
                .len(),
            32
        );
        assert!(
            s.badges
                .iter()
                .all(|b| b.target > 0 && b.earned && b.progress == b.target)
        );
        for (id, target) in [
            ("thousand-goals", 1_000),
            ("hundred-thousand-turns", 100_000),
            ("ten-million-tools", 10_000_000),
            ("year-streak", 365),
            ("week-goal", 168),
            ("five-thousand-turn-chat", 5_000),
        ] {
            assert_eq!(s.badges.iter().find(|b| b.id == id).unwrap().target, target);
        }
        assert!(
            s.notices.is_empty(),
            "historical activity must not trigger a celebration backlog"
        );
    }
    #[test]
    fn new_badges_unlock_quietly_on_upgrade_then_celebrate_new_progress_once() {
        // An actual pre-expansion ledger has no catalog/discovery receipts.
        let mut ledger: Ledger = serde_json::from_value(serde_json::json!({"initialized":true,"earned":["first-goal","ten-goals","ten-turns","hundred-turns","thousand-tools","ten-thousand-tools","three-days","seven-days"]})).unwrap();
        let mut d = data("2026-10-18");
        d.lifetime = Totals {
            goals: 99,
            turns: 9_999,
            tool_calls: 1_000_000,
            ..Default::default()
        };
        let s = build(&mut ledger, &d, &[], ExtrasConfig::default(), 1).unwrap();
        assert!(s.notices.is_empty());
        for id in [
            "first-goal",
            "seven-days",
            "twenty-five-goals",
            "thousand-turns",
            "million-tools",
        ] {
            assert!(s.badges.iter().find(|b| b.id == id).unwrap().earned, "{id}");
        }
        assert!(
            !s.badges
                .iter()
                .find(|b| b.id == "ten-thousand-turns")
                .unwrap()
                .earned
        );
        d.lifetime.turns = 10_000;
        let s = build(&mut ledger, &d, &[], ExtrasConfig::default(), 2).unwrap();
        assert_eq!(s.notices.len(), 1);
        assert_eq!(s.notices[0].id, token("badge:ten-thousand-turns"));
        ledger.pending.clear();
        ledger = serde_json::from_slice(&serde_json::to_vec(&ledger).unwrap()).unwrap();
        d.lifetime.turns = 10_001;
        assert!(
            build(&mut ledger, &d, &[], ExtrasConfig::default(), 3)
                .unwrap()
                .notices
                .is_empty()
        );
    }
    #[test]
    fn conversation_badges_require_one_chat_instead_of_aggregate_turns() {
        let mut ledger = Ledger::default();
        let mut d = data("2026-10-18");
        d.lifetime.turns = 120;
        d.conversations = vec![conversation("first", 60), conversation("second", 60)];
        let s = build(&mut ledger, &d, &[], ExtrasConfig::default(), 1).unwrap();
        let badge = s
            .badges
            .iter()
            .find(|b| b.id == "hundred-turn-chat")
            .unwrap();
        assert!(!badge.earned);
        assert_eq!(badge.progress, 60);
        d.conversations[0].totals.turns = 100;
        let s = build(&mut ledger, &d, &[], ExtrasConfig::default(), 2).unwrap();
        assert_eq!(s.notices.len(), 1);
        assert_eq!(s.notices[0].id, token("badge:hundred-turn-chat"));
    }
    #[test]
    fn goal_badges_count_active_hours_and_do_not_repeat_after_pause_or_resume() {
        let root = tempfile::tempdir().unwrap();
        let chat = root.path().join("CHAT.md");
        let path = root.path().join("automation.json");
        let chats = vec![("goal-chat".into(), chat)];
        let mut ledger = Ledger::default();
        let d = data("2026-10-18");
        let six_hours = 6_u64 * 3_600_000;
        let goal = |elapsed, state, since, until| serde_json::json!({"goal":{"createdAtMs":1,"elapsedActiveMs":elapsed,"status":state,"activeSinceMs":since,"timerUntilMs":until,"turnCount":1}});
        std::fs::write(&path, goal(six_hours - 1, "blocked", 0, 0).to_string()).unwrap();
        let s = build(&mut ledger, &d, &chats, ExtrasConfig::default(), 10_000).unwrap();
        let badge = s.badges.iter().find(|b| b.id == "six-hour-goal").unwrap();
        assert!(!badge.earned);
        assert_eq!(badge.progress, 5);
        std::fs::write(&path, goal(six_hours, "blocked", 0, 0).to_string()).unwrap();
        let s = build(&mut ledger, &d, &chats, ExtrasConfig::default(), 20_000).unwrap();
        assert_eq!(s.notices.len(), 1);
        assert_eq!(s.notices[0].id, token("badge:six-hour-goal"));
        ledger.pending.clear();
        ledger = serde_json::from_slice(&serde_json::to_vec(&ledger).unwrap()).unwrap();
        std::fs::write(&path, goal(six_hours, "active", 30_000, 35_000).to_string()).unwrap();
        let s = build(&mut ledger, &d, &chats, ExtrasConfig::default(), 100_000).unwrap();
        assert!(s.notices.is_empty());
        assert_eq!(
            s.badges
                .iter()
                .find(|b| b.id == "six-hour-goal")
                .unwrap()
                .progress,
            6
        );
        assert_eq!(record_value(&s, "goalActiveMs"), six_hours + 5_000);
    }
    #[test]
    fn weekly_recap_is_completed_calendar_week_and_claimed_once_across_year_boundary() {
        let mut d = data("2027-01-04");
        d.daily = vec![
            day("2026-12-27", 999),
            day("2026-12-28", 2),
            day("2027-01-03", 3),
            day("2027-01-04", 1000),
        ];
        let mut ledger = Ledger::default();
        let s = build(&mut ledger, &d, &[], ExtrasConfig::default(), 1).unwrap();
        assert_eq!(s.week.start, "2026-12-28");
        assert_eq!(s.week.end, "2027-01-03");
        assert_eq!(s.week.totals.turns, 5);
        assert_eq!(s.week.activity, vec![2, 0, 0, 0, 0, 0, 3]);
        assert_eq!(s.week.active_days, 2);
        assert!(s.week.ready);
        ledger.recaps.insert(s.week.id);
        assert!(
            !build(&mut ledger, &d, &[], ExtrasConfig::default(), 2)
                .unwrap()
                .week
                .ready
        );
        d.today = "2027-01-10".into();
        assert!(
            !build(&mut ledger, &d, &[], ExtrasConfig::default(), 3)
                .unwrap()
                .week
                .ready
        );
        d.today = "2027-01-11".into();
        assert!(
            build(&mut ledger, &d, &[], ExtrasConfig::default(), 4)
                .unwrap()
                .week
                .ready
        );
    }
    #[test]
    fn empty_weeks_never_interrupt_and_disabled_features_keep_statistics_without_backlog() {
        let mut ledger = Ledger::default();
        let mut d = data("2026-10-18");
        assert!(
            !build(&mut ledger, &d, &[], ExtrasConfig::default(), 1)
                .unwrap()
                .week
                .ready
        );
        let p = ExtrasConfig {
            achievements: false,
            personal_records: false,
            daily_streaks: false,
            weekly_recap: false,
            animations: false,
        };
        d.daily = vec![day("2026-10-11", 1), day("2026-10-18", 10)];
        d.streak = 1;
        d.lifetime.turns = 10;
        d.conversations = vec![conversation("new", 10)];
        let s = build(&mut ledger, &d, &[], p, 2).unwrap();
        assert_eq!(record_value(&s, "conversationTurns"), 10);
        assert_eq!(s.streak, 1);
        assert!(s.badges.iter().any(|b| b.earned));
        assert!(!s.week.ready);
        assert!(s.notices.is_empty());
        let s = build(&mut ledger, &d, &[], ExtrasConfig::default(), 3).unwrap();
        assert!(s.notices.is_empty());
        assert!(!s.week.ready);
    }
    #[test]
    fn streak_badges_are_durable_and_yesterday_is_not_a_broken_streak() {
        let mut ledger = Ledger::default();
        let mut d = data("2026-10-18");
        build(&mut ledger, &d, &[], ExtrasConfig::default(), 1).unwrap();
        d.daily = vec![
            day("2026-10-15", 1),
            day("2026-10-16", 1),
            day("2026-10-17", 1),
        ];
        d.streak = 3;
        let s = build(&mut ledger, &d, &[], ExtrasConfig::default(), 2).unwrap();
        assert_eq!(s.best_streak, 3);
        assert!(!s.active_today);
        assert!(
            s.badges
                .iter()
                .find(|b| b.id == "three-days")
                .unwrap()
                .earned
        );
        assert_eq!(
            s.notices.iter().filter(|n| n.kind == "achievement").count(),
            1
        );
        ledger.pending.clear();
        d.today = "2026-10-19".into();
        d.streak = 0;
        let s = build(&mut ledger, &d, &[], ExtrasConfig::default(), 3).unwrap();
        assert_eq!(s.streak, 0);
        assert_eq!(s.best_streak, 3);
        assert!(s.notices.is_empty());
    }
    #[test]
    fn extras_settings_apply_live_without_enabling_renewal_or_erasing_statistics() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("settings.json");
        std::fs::write(
            &path,
            serde_json::json!({"workDir":temp.path()}).to_string(),
        )
        .unwrap();
        let mut config = crate::config::default_config(temp.path().into());
        config.loaded_config_path = Some(path);
        let before = crate::global_settings::snapshot(&config).unwrap();
        assert_eq!(
            before["defaults"]["agentChat"]["extras"]["weeklyRecap"],
            true
        );
        let after = crate::global_settings::save(
            &config,
            before["revision"].as_str().unwrap(),
            None,
            Some(serde_json::Map::from_iter([
                (
                    "agentChat.extras.animations".into(),
                    serde_json::json!(false),
                ),
                (
                    "agentChat.extras.weeklyRecap".into(),
                    serde_json::json!(false),
                ),
            ])),
        )
        .unwrap();
        assert_eq!(after["restartRequired"], false);
        assert!(after["document"]["agentChat"]["turnRenewal"].is_null());
        let p = crate::global_settings::extras(&config).unwrap();
        assert!(!p.animations && !p.weekly_recap);
        assert!(p.achievements && p.personal_records && p.daily_streaks);
        assert_eq!(
            after["document"]["agentChat"]["extras"]
                .as_object()
                .unwrap()
                .len(),
            2
        );
    }
    #[test]
    fn claim_is_persistent_single_winner_and_corruption_is_not_reset() {
        let temp = tempfile::tempdir().unwrap();
        let mut config = crate::config::default_config(temp.path().into());
        config.memory.dir = Some(temp.path().display().to_string());
        let path = ledger_path(&config);
        let id = token("record");
        let mut ledger = Ledger {
            initialized: true,
            ..Default::default()
        };
        ledger.pending.insert(
            id.clone(),
            Notice {
                id: id.clone(),
                kind: "record".into(),
                title: "record".into(),
                detail: "test".into(),
                at: 1,
            },
        );
        save(&path, &ledger).unwrap();
        std::thread::scope(|scope| {
            let claims: Vec<_> = (0..8)
                .map(|_| scope.spawn(|| claim(&config, &id).unwrap()))
                .collect();
            assert_eq!(
                claims
                    .into_iter()
                    .map(|t| t.join().unwrap())
                    .filter(|won| *won)
                    .count(),
                1
            );
        });
        assert!(!claim(&config, &id).unwrap());
        assert!(claim(&config, "week:2026-10-11").unwrap());
        assert!(!claim(&config, "week:2026-10-11").unwrap());
        std::fs::write(&path, "broken data").unwrap();
        assert!(claim(&config, &id).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "broken data");
    }
}
