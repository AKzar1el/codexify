//! Local, best-effort usage counters. Never drives chat or goal automation.
use crate::{
    agent_automation::{GoalRecord, GoalStatus, turn_renewal::TurnSend},
    types::AppConfig,
};
use chrono::{Datelike, Local, TimeZone};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap, VecDeque},
    fs::OpenOptions,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        OnceLock,
        mpsc::{RecvTimeoutError, SyncSender, sync_channel},
    },
    time::{Duration, Instant},
};
const FILE: &str = "usage-analytics.json";
const MAX_BYTES: u64 = 8 * 1024 * 1024;
const MAX_INTERVAL: u64 = 5 * 60 * 60 * 1000;
const UNKNOWN: &str = "unattributed\u{1f}unknown";
// Collection is always active; keep the context type for existing call sites.
#[derive(Clone, Debug, Default)]
pub(crate) struct Options {}
impl Options {
    pub(crate) fn from_config(_config: &AppConfig) -> Self {
        Self {}
    }
}
#[derive(Clone)]
enum Event {
    Sent(TurnSend),
    Goal { id: String },
    Tool { id: String, waiting: bool },
    End { id: String },
}
struct Packet {
    chat: PathBuf,
    at: u64,
    event: Event,
}
static SINK: OnceLock<Option<SyncSender<Packet>>> = OnceLock::new();
pub(crate) fn initialize() {
    SINK.get_or_init(|| {
        let (tx, rx) = sync_channel::<Packet>(4096);
        let started = crate::markdown_chat::now_ms();
        std::thread::Builder::new()
            .name("usage-analytics".into())
            .spawn(move || {
                let mut cache: HashMap<PathBuf, Option<Tracker>> = HashMap::new();
                let mut flushed = Instant::now();
                loop {
                    match rx.recv_timeout(Duration::from_secs(2)) {
                        Ok(p) => {
                            if cache.len() >= 64
                                && !cache.contains_key(&p.chat)
                                && let Some(victim) = cache
                                    .iter()
                                    .min_by_key(|(_, entry)| entry.as_ref().map(|t| t.last_seen))
                                    .map(|(path, _)| path.clone())
                                && let Some(Some(t)) = cache.remove(&victim)
                                && t.dirty
                            {
                                let _ = save(&victim.with_file_name(FILE), &t.data);
                            }
                            let entry = cache.entry(p.chat.clone()).or_insert_with(|| {
                                load(&p.chat.with_file_name(FILE))
                                    .map(|d| Tracker::new(d.unwrap_or_else(|| Data::new(started))))
                                    .ok()
                            });
                            if let Some(t) = entry {
                                t.apply(&p);
                            }
                        }
                        Err(RecvTimeoutError::Disconnected) => break,
                        Err(RecvTimeoutError::Timeout) => {}
                    }
                    if flushed.elapsed() >= Duration::from_secs(2) {
                        for (chat, entry) in &mut cache {
                            if let Some(t) = entry
                                && t.dirty
                                && save(&chat.with_file_name(FILE), &t.data).is_ok()
                            {
                                t.dirty = false;
                            }
                        }
                        flushed = Instant::now();
                    }
                }
            })
            .ok()
            .map(|_| tx)
    });
}
fn enqueue(_options: &Options, chat: PathBuf, at: u64, event: Event) {
    initialize();
    if let Some(tx) = SINK.get().and_then(Option::as_ref) {
        let _ = tx.try_send(Packet { chat, at, event });
    }
}
pub(crate) fn sent(options: &Options, chat: PathBuf, send: TurnSend) {
    enqueue(options, chat, send.at_ms, Event::Sent(send));
}
pub(crate) fn goal(options: &Options, chat: PathBuf, goal: &GoalRecord) {
    if goal.status == GoalStatus::Completed
        && let Some(at) = goal.finished_at_ms
    {
        enqueue(
            options,
            chat,
            at,
            Event::Goal {
                id: format!("{}:{at}", goal.revision),
            },
        );
    }
}
pub(crate) struct ToolGuard {
    options: Options,
    chat: PathBuf,
    id: String,
}
impl Drop for ToolGuard {
    fn drop(&mut self) {
        enqueue(
            &self.options,
            self.chat.clone(),
            crate::markdown_chat::now_ms(),
            Event::End {
                id: self.id.clone(),
            },
        );
    }
}
pub(crate) fn tool(
    config: &AppConfig,
    chat: &Path,
    a: &crate::markdown_chat::AgentActivity,
    name: &str,
) -> ToolGuard {
    let options = Options::from_config(config);
    let id = format!("{}:{}", a.epoch, a.sequence);
    let chat = chat.to_path_buf();
    enqueue(
        &options,
        chat.clone(),
        a.at_ms,
        Event::Tool {
            id: id.clone(),
            waiting: matches!(name, "chat_await" | "turn_completed"),
        },
    );
    ToolGuard { options, chat, id }
}
#[derive(Clone, Default, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Totals {
    pub turns: u64,
    pub tool_calls: u64,
    pub goals: u64,
    pub active_ms: u64,
}
impl Totals {
    pub(crate) fn add(&mut self, o: &Self) {
        self.turns = self.turns.saturating_add(o.turns);
        self.tool_calls = self.tool_calls.saturating_add(o.tool_calls);
        self.goals = self.goals.saturating_add(o.goals);
        self.active_ms = self.active_ms.saturating_add(o.active_ms);
    }
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Data {
    version: u32,
    since: u64,
    days: BTreeMap<String, BTreeMap<String, Totals>>,
    sends: VecDeque<String>,
    tools: VecDeque<String>,
    goals: VecDeque<String>,
    latest_send: u64,
    send_models: BTreeMap<String, (u64, String)>,
}
impl Data {
    fn new(since: u64) -> Self {
        Self {
            version: 1,
            since,
            days: BTreeMap::new(),
            sends: VecDeque::new(),
            tools: VecDeque::new(),
            goals: VecDeque::new(),
            latest_send: 0,
            send_models: BTreeMap::new(),
        }
    }
}
struct Tracker {
    data: Data,
    model: String,
    last_work: Option<(u64, String, bool)>,
    pending: HashMap<String, (u64, String)>,
    coverage: HashMap<String, Vec<(u64, u64)>>,
    dirty: bool,
    idle: bool,
    last_seen: Instant,
}
impl Tracker {
    fn new(data: Data) -> Self {
        Self {
            data,
            model: UNKNOWN.into(),
            last_work: None,
            pending: HashMap::new(),
            coverage: HashMap::new(),
            dirty: false,
            idle: true,
            last_seen: Instant::now(),
        }
    }
    fn total(&mut self, at: u64, model: &str, delta: Totals) {
        if let Some(date) = date(at) {
            let existing = self
                .data
                .days
                .get(&date)
                .is_some_and(|models| models.contains_key(model));
            if !existing && self.data.days.values().map(BTreeMap::len).sum::<usize>() >= 20_000 {
                return;
            }
            self.data
                .days
                .entry(date)
                .or_default()
                .entry(model.into())
                .or_default()
                .add(&delta);
            self.dirty = true;
        }
    }
    fn identify(&mut self, chat: &Path) {
        if let Ok(Some(bytes)) = read(&chat.with_file_name("automation.json"), 1024 * 1024)
            && let Ok(v) = serde_json::from_slice::<serde_json::Value>(&bytes)
            && let Some(send) = v.pointer("/turnRenewal/send")
            && let (Some(model), Some(effort)) = (send["model"].as_str(), send["effort"].as_str())
        {
            self.model = model_key(model, effort);
        }
    }
    fn credit(&mut self, from: u64, to: u64, model: &str) {
        if to <= from || to - from > MAX_INTERVAL {
            return;
        }
        let from = from.max(self.data.since);
        if to <= from {
            return;
        }
        let spans = self.coverage.entry(model.into()).or_default();
        let mut uncovered = vec![(from, to)];
        for &(a, b) in spans.iter() {
            uncovered = uncovered
                .into_iter()
                .flat_map(|(x, y)| {
                    let mut out = Vec::new();
                    if a >= y || b <= x {
                        out.push((x, y));
                    } else {
                        if x < a {
                            out.push((x, a));
                        }
                        if b < y {
                            out.push((b, y));
                        }
                    }
                    out
                })
                .collect();
        }
        spans.push((from, to));
        spans.sort_unstable();
        let mut merged: Vec<(u64, u64)> = Vec::new();
        for &(a, b) in spans.iter() {
            if let Some(last) = merged.last_mut()
                && a <= last.1
            {
                last.1 = last.1.max(b);
            } else {
                merged.push((a, b));
            }
        }
        merged.retain(|(_, b)| *b >= to.saturating_sub(MAX_INTERVAL));
        *spans = merged;
        for (mut a, b) in uncovered {
            while a < b {
                let Some(end) = next_day(a).map(|end| end.min(b)) else {
                    break;
                };
                if end <= a {
                    break;
                }
                self.total(
                    a,
                    model,
                    Totals {
                        active_ms: end - a,
                        ..Default::default()
                    },
                );
                a = end;
            }
        }
    }
    fn apply(&mut self, p: &Packet) {
        self.last_seen = Instant::now();
        if p.at < self.data.since || p.at > crate::markdown_chat::now_ms().saturating_add(60_000) {
            return;
        }
        match &p.event {
            Event::Sent(send) => {
                let key = send
                    .model
                    .as_deref()
                    .zip(send.effort.as_deref())
                    .map(|(m, e)| model_key(m, e))
                    .unwrap_or_else(|| UNKNOWN.into());
                if send.at_ms >= self.data.latest_send {
                    self.model = key.clone();
                }
                if self.data.sends.contains(&send.action_id) {
                    if let Some((at, previous)) =
                        self.data.send_models.get(&send.action_id).cloned()
                        && previous == UNKNOWN
                        && key != UNKNOWN
                    {
                        if let Some(day) = date(at)
                            && let Some(total) = self
                                .data
                                .days
                                .get_mut(&day)
                                .and_then(|models| models.get_mut(&previous))
                        {
                            total.turns = total.turns.saturating_sub(1);
                        }
                        self.total(
                            at,
                            &key,
                            Totals {
                                turns: 1,
                                ..Default::default()
                            },
                        );
                        self.data
                            .send_models
                            .insert(send.action_id.clone(), (at, key));
                    }
                    return;
                }
                if send.at_ms < self.data.latest_send {
                    return;
                }
                remember(&mut self.data.sends, send.action_id.clone(), 256);
                self.data
                    .send_models
                    .retain(|id, _| self.data.sends.contains(id));
                self.data
                    .send_models
                    .insert(send.action_id.clone(), (p.at, key.clone()));
                self.data.latest_send = send.at_ms;
                self.total(
                    p.at,
                    &key,
                    Totals {
                        turns: 1,
                        ..Default::default()
                    },
                );
                self.last_work = Some((p.at, key, true));
                self.idle = false;
            }
            Event::Goal { id } => {
                if self.data.goals.contains(id) {
                    return;
                }
                self.identify(&p.chat);
                remember(&mut self.data.goals, id.clone(), 256);
                let key = self.model.clone();
                self.total(
                    p.at,
                    &key,
                    Totals {
                        goals: 1,
                        ..Default::default()
                    },
                );
                self.last_work = None;
                self.idle = true;
            }
            Event::Tool { id, waiting } => {
                if self.data.tools.contains(id) {
                    return;
                }
                self.identify(&p.chat);
                remember(&mut self.data.tools, id.clone(), 2048);
                let key = self.model.clone();
                if !waiting {
                    self.total(
                        p.at,
                        &key,
                        Totals {
                            tool_calls: 1,
                            ..Default::default()
                        },
                    );
                }
                if let Some((at, model, send)) = self.last_work.take()
                    && p.at >= at
                    && p.at - at
                        <= if send {
                            MAX_INTERVAL
                        } else {
                            crate::markdown_chat::OFFLINE_AFTER_MS
                        }
                {
                    self.credit(at, p.at, &model);
                }
                if *waiting {
                    self.idle = true;
                    self.last_work = None;
                } else {
                    self.idle = false;
                    self.last_work = Some((p.at, key.clone(), false));
                    if self.pending.len() < 256 {
                        self.pending.insert(id.clone(), (p.at, key));
                    }
                }
            }
            Event::End { id } => {
                if let Some((at, key)) = self.pending.remove(id) {
                    self.credit(at, p.at, &key);
                    if !self.idle
                        && self
                            .last_work
                            .as_ref()
                            .is_none_or(|(last, _, _)| *last <= p.at)
                    {
                        self.last_work = Some((p.at, key, false));
                    }
                }
            }
        }
    }
}
fn remember(ids: &mut VecDeque<String>, id: String, max: usize) {
    ids.push_back(id);
    while ids.len() > max {
        ids.pop_front();
    }
}
fn model_key(model: &str, effort: &str) -> String {
    if model.is_empty()
        || effort.is_empty()
        || model.len() > 128
        || effort.len() > 32
        || model.chars().chain(effort.chars()).any(char::is_control)
    {
        UNKNOWN.into()
    } else {
        format!("{model}\u{1f}{effort}")
    }
}
fn date(at: u64) -> Option<String> {
    Some(
        Local
            .timestamp_millis_opt(i64::try_from(at).ok()?)
            .single()?
            .format("%Y-%m-%d")
            .to_string(),
    )
}
fn next_day(at: u64) -> Option<u64> {
    let d = Local
        .timestamp_millis_opt(i64::try_from(at).ok()?)
        .single()?
        .date_naive()
        .succ_opt()?;
    u64::try_from(
        Local
            .with_ymd_and_hms(d.year(), d.month(), d.day(), 0, 0, 0)
            .earliest()?
            .timestamp_millis(),
    )
    .ok()
}
pub(crate) fn read(path: &Path, max: u64) -> Result<Option<Vec<u8>>, ()> {
    let meta = match std::fs::symlink_metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(()),
    };
    if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > max {
        return Err(());
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options.open(path).map_err(|_| ())?;
    if !file.metadata().map_err(|_| ())?.is_file() {
        return Err(());
    }
    let mut bytes = Vec::new();
    file.take(max + 1).read_to_end(&mut bytes).map_err(|_| ())?;
    if bytes.len() as u64 > max {
        return Err(());
    }
    Ok(Some(bytes))
}
fn load(path: &Path) -> Result<Option<Data>, ()> {
    let Some(bytes) = read(path, MAX_BYTES)? else {
        return Ok(None);
    };
    let data: Data = serde_json::from_slice(&bytes).map_err(|_| ())?;
    if data.version != 1
        || data.tools.len() > 2048
        || data.sends.len() > 256
        || data.goals.len() > 256
        || data.days.len() > 36600
    {
        return Err(());
    }
    Ok(Some(data))
}
fn save(path: &Path, data: &Data) -> Result<(), ()> {
    if std::fs::symlink_metadata(path).is_ok_and(|m| !m.is_file() || m.file_type().is_symlink()) {
        return Err(());
    }
    let bytes = serde_json::to_vec(data).map_err(|_| ())?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err(());
    }
    let mut temp = tempfile::NamedTempFile::new_in(path.parent().ok_or(())?).map_err(|_| ())?;
    temp.write_all(&bytes).map_err(|_| ())?;
    temp.persist(path).map_err(|_| ())?;
    Ok(())
}
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Dashboard {
    pub since: Option<u64>,
    pub timezone: String,
    pub today: String,
    pub daily: Vec<Daily>,
    pub models: Vec<Model>,
    pub conversations: Vec<Conversation>,
    pub lifetime: Totals,
    pub totals: Totals,
    pub active_days: usize,
    pub streak: usize,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Daily {
    pub date: String,
    pub models: BTreeMap<String, Totals>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Model {
    pub id: String,
    pub model: String,
    pub effort: String,
    #[serde(flatten)]
    pub totals: Totals,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Conversation {
    pub id: String,
    #[serde(flatten)]
    pub totals: Totals,
}
pub(crate) fn dashboard(
    chats: impl IntoIterator<Item = (String, PathBuf)>,
    days: Option<u32>,
    now: u64,
    _options: &Options,
) -> Dashboard {
    let today = Local
        .timestamp_millis_opt(now as i64)
        .single()
        .unwrap_or_else(Local::now)
        .date_naive();
    let first = days
        .and_then(|n| {
            today.checked_sub_signed(chrono::Duration::days(i64::from(n.saturating_sub(1))))
        })
        .map(|d| d.to_string());
    let mut result = Dashboard {
        timezone: Local::now().format("%Z").to_string(),
        today: today.to_string(),
        ..Default::default()
    };
    let mut daily: BTreeMap<String, BTreeMap<String, Totals>> = BTreeMap::new();
    let mut models: BTreeMap<String, Totals> = BTreeMap::new();
    let mut active_dates = BTreeSet::new();
    for (id, chat) in chats.into_iter().take(4096) {
        let Ok(Some(data)) = load(&chat.with_file_name(FILE)) else {
            continue;
        };
        result.since = Some(result.since.map_or(data.since, |s| s.min(data.since)));
        let mut conversation = Totals::default();
        for (day, values) in data.days {
            if chrono::NaiveDate::parse_from_str(&day, "%Y-%m-%d").is_err()
                || day > today.to_string()
            {
                continue;
            }
            for (key, value) in values {
                if value == Totals::default()
                    || !key
                        .split_once('\u{1f}')
                        .is_some_and(|(m, e)| model_key(m, e) == key)
                {
                    continue;
                }
                result.lifetime.add(&value);
                active_dates.insert(day.clone());
                if first.as_ref().is_some_and(|first| day < *first) {
                    continue;
                }
                daily
                    .entry(day.clone())
                    .or_default()
                    .entry(key.clone())
                    .or_default()
                    .add(&value);
                models.entry(key).or_default().add(&value);
                conversation.add(&value);
            }
        }
        if conversation != Totals::default() {
            result.totals.add(&conversation);
            result.conversations.push(Conversation {
                id,
                totals: conversation,
            });
        }
    }
    result.active_days = daily.len();
    let mut check = today;
    for _ in 0..36600 {
        if active_dates.contains(&check.to_string()) {
            result.streak += 1;
        } else if check != today {
            break;
        }
        let Some(prev) = check.pred_opt() else { break };
        check = prev;
    }
    result.daily = daily
        .into_iter()
        .map(|(date, models)| Daily { date, models })
        .collect();
    result.models = models
        .into_iter()
        .map(|(id, totals)| {
            let (model, effort) = id
                .split_once('\u{1f}')
                .unwrap_or(("unattributed", "unknown"));
            Model {
                model: model.into(),
                effort: effort.into(),
                id,
                totals,
            }
        })
        .collect();
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    const BASE: u64 = 1_700_000_000_000;
    fn tracker() -> Tracker {
        Tracker::new(Data::new(BASE))
    }
    fn p(at: u64, event: Event) -> Packet {
        Packet {
            chat: PathBuf::from("/absent/CHAT.md"),
            at,
            event,
        }
    }
    fn send(id: &str, at: u64, model: Option<&str>) -> Packet {
        p(
            at,
            Event::Sent(TurnSend {
                action_id: id.into(),
                at_ms: at,
                model: model.map(Into::into),
                effort: model.map(|_| "high".into()),
                pairing_generation: 1,
                owner_generation: 1,
            }),
        )
    }
    fn tool(id: &str, at: u64, waiting: bool) -> Packet {
        p(
            at,
            Event::Tool {
                id: id.into(),
                waiting,
            },
        )
    }
    fn end(id: &str, at: u64) -> Packet {
        p(at, Event::End { id: id.into() })
    }
    fn sum(t: &Tracker) -> Totals {
        let mut total = Totals::default();
        for m in t.data.days.values() {
            for value in m.values() {
                total.add(value);
            }
        }
        total
    }
    #[test]
    fn accepted_sends_are_deduplicated_and_actual_fallback_models_are_distinct() {
        let mut t = tracker();
        t.apply(&send("one", BASE, Some("actual-fallback")));
        t.apply(&send("one", BASE, Some("actual-fallback")));
        t.apply(&send("two", BASE + 10, Some("other")));
        assert_eq!(sum(&t).turns, 2);
        assert_eq!(t.data.days[&date(BASE).unwrap()].len(), 2);
    }
    #[test]
    fn fallback_turns_tools_time_and_goals_use_actual_model_and_effort() {
        let dir = tempfile::tempdir().unwrap();
        let chat = dir.path().join("CHAT.md");
        std::fs::write(
            dir.path().join("automation.json"),
            serde_json::json!({
                "selection":{"model":"gpt-6-astra","effort":"max"},
                "turnRenewal":{"send":{"model":"gpt-5.6-sol","effort":"max"}}
            })
            .to_string(),
        )
        .unwrap();
        let mut t = tracker();
        let mut sent = send("fallback", BASE, Some("gpt-5.6-sol"));
        if let Event::Sent(send) = &mut sent.event {
            send.effort = Some("max".into());
        }
        sent.chat = chat.clone();
        t.apply(&sent);
        let mut work = tool("work", BASE + 60_000, false);
        work.chat = chat.clone();
        t.apply(&work);
        t.apply(&end("work", BASE + 120_000));
        let mut completed = p(
            BASE + 120_001,
            Event::Goal {
                id: "finished".into(),
            },
        );
        completed.chat = chat;
        t.apply(&completed);
        let day = &t.data.days[&date(BASE).unwrap()];
        assert_eq!(
            day.len(),
            1,
            "the saved preference must not receive fallback usage"
        );
        let actual = &day[&model_key("gpt-5.6-sol", "max")];
        assert_eq!(actual.turns, 1);
        assert_eq!(actual.tool_calls, 1);
        assert_eq!(actual.active_ms, 120_000);
        assert_eq!(actual.goals, 1);
    }
    #[test]
    fn late_model_proof_reattributes_a_turn_instead_of_counting_it_twice() {
        let mut t = tracker();
        t.apply(&send("one", BASE, None));
        t.apply(&send("one", BASE, Some("actual")));
        assert_eq!(sum(&t).turns, 1);
        let day = &t.data.days[&date(BASE).unwrap()];
        assert_eq!(day[UNKNOWN].turns, 0);
        assert_eq!(day[&model_key("actual", "high")].turns, 1);
    }
    #[test]
    fn waiting_loops_do_not_farm_tool_counters_or_active_time() {
        let mut t = tracker();
        t.apply(&send("one", BASE, Some("model")));
        t.apply(&tool("work", BASE + 60_000, false));
        t.apply(&end("work", BASE + 120_000));
        t.apply(&tool("wait", BASE + 180_000, true));
        t.apply(&tool("wait-again", BASE + 86_400_000, true));
        assert_eq!(
            sum(&t),
            Totals {
                turns: 1,
                tool_calls: 1,
                goals: 0,
                active_ms: 180_000
            }
        );
        assert_eq!(t.data.days.len(), 1);
    }
    #[test]
    fn overlapping_native_requests_count_each_tool_but_union_their_time() {
        let mut t = tracker();
        t.apply(&tool("a", BASE, false));
        t.apply(&tool("b", BASE + 20_000, false));
        t.apply(&end("b", BASE + 80_000));
        t.apply(&end("a", BASE + 100_000));
        assert_eq!(sum(&t).tool_calls, 2);
        assert_eq!(sum(&t).active_ms, 100_000);
        t.apply(&tool("a", BASE, false));
        assert_eq!(sum(&t).tool_calls, 2);
    }
    #[test]
    fn long_running_tools_count_but_unexplained_idle_gaps_do_not() {
        let mut t = tracker();
        t.apply(&tool("a", BASE, false));
        t.apply(&end("a", BASE + 60_000));
        t.apply(&tool("b", BASE + 3_600_000, false));
        t.apply(&end("b", BASE + 3_600_000 + 40 * 60_000));
        assert_eq!(sum(&t).active_ms, 41 * 60_000);
    }
    #[test]
    fn restarts_never_credit_downtime_or_replay_deduped_events() {
        let mut t = tracker();
        t.apply(&tool("a", BASE, false));
        t = Tracker::new(t.data);
        t.apply(&end("a", BASE + 10_000));
        assert_eq!(sum(&t).active_ms, 0);
        let mut t = Tracker::new(t.data);
        t.apply(&tool("a", BASE, false));
        t.apply(&tool("new", BASE + 86_400_000, false));
        assert_eq!(sum(&t).tool_calls, 2);
        assert_eq!(sum(&t).active_ms, 0);
    }
    #[test]
    fn no_historical_backfill_or_future_events_and_no_abnormal_intervals() {
        let mut t = tracker();
        t.apply(&send("old", BASE - 1, Some("model")));
        t.apply(&tool("old", BASE - 1, false));
        t.apply(&p(BASE - 1, Event::Goal { id: "old".into() }));
        t.apply(&tool(
            "future",
            crate::markdown_chat::now_ms() + 120_000,
            false,
        ));
        assert_eq!(sum(&t), Totals::default());
        t.credit(BASE, BASE + MAX_INTERVAL + 1, UNKNOWN);
        assert_eq!(sum(&t).active_ms, 0);
        t.credit(BASE, BASE + MAX_INTERVAL, UNKNOWN);
        assert_eq!(sum(&t).active_ms, MAX_INTERVAL);
    }
    #[test]
    fn local_midnight_splits_time_into_the_correct_days() {
        let mut t = tracker();
        let midnight = next_day(BASE).unwrap();
        t.credit(midnight - 120_000, midnight + 120_000, UNKNOWN);
        assert_eq!(
            t.data.days[&date(midnight - 1).unwrap()][UNKNOWN].active_ms,
            120_000
        );
        assert_eq!(
            t.data.days[&date(midnight).unwrap()][UNKNOWN].active_ms,
            120_000
        );
    }
    #[test]
    fn repeated_goal_completion_is_counted_once_and_pauses_active_intervals() {
        let mut t = tracker();
        t.apply(&p(
            BASE,
            Event::Goal {
                id: "revision-1:completed-at".into(),
            },
        ));
        t.apply(&p(
            BASE,
            Event::Goal {
                id: "revision-1:completed-at".into(),
            },
        ));
        assert_eq!(sum(&t).goals, 1);
        assert!(t.idle);
        assert!(t.last_work.is_none());
    }
    #[test]
    fn range_totals_lifetime_models_and_conversation_leaderboard_agree() {
        let dir = tempfile::tempdir().unwrap();
        let chat = dir.path().join("CHAT.md");
        let mut t = tracker();
        t.apply(&send("old", BASE, Some("model")));
        t.apply(&send("recent", BASE + 35 * 86_400_000, Some("model")));
        t.apply(&tool("tool", BASE + 35 * 86_400_000, false));
        save(&chat.with_file_name(FILE), &t.data).unwrap();
        let now = BASE + 40 * 86_400_000;
        let d = dashboard(
            [("id".into(), chat.clone())],
            Some(7),
            now,
            &Options::default(),
        );
        assert_eq!(
            (
                d.totals.turns,
                d.lifetime.turns,
                d.models[0].totals.turns,
                d.conversations[0].totals.turns
            ),
            (1, 2, 1, 1)
        );
        assert_eq!(d.active_days, 1);
        let all = dashboard([("id".into(), chat)], None, now, &Options::default());
        assert_eq!(all.totals.turns, 2);
        assert_eq!(all.daily.len(), 2);
    }
    #[test]
    fn corrupt_files_are_preserved_and_silently_ignored() {
        let dir = tempfile::tempdir().unwrap();
        let chat = dir.path().join("CHAT.md");
        let path = chat.with_file_name(FILE);
        for bytes in [
            b"invalid".to_vec(),
            br#"{"version":999}"#.to_vec(),
            vec![b'x'; MAX_BYTES as usize + 1],
        ] {
            std::fs::write(&path, &bytes).unwrap();
            assert!(load(&path).is_err());
            assert_eq!(
                dashboard(
                    [("id".into(), chat.clone())],
                    None,
                    BASE,
                    &Options::default()
                )
                .totals,
                Totals::default()
            );
            assert_eq!(std::fs::read(&path).unwrap(), bytes);
        }
    }
    #[cfg(unix)]
    #[test]
    fn symlinks_are_not_read_or_replaced() {
        let dir = tempfile::tempdir().unwrap();
        let protected = dir.path().join("protected");
        std::fs::write(&protected, b"protected").unwrap();
        let path = dir.path().join(FILE);
        std::os::unix::fs::symlink(&protected, &path).unwrap();
        assert!(load(&path).is_err());
        assert!(save(&path, &Data::new(BASE)).is_err());
        assert_eq!(std::fs::read(&protected).unwrap(), b"protected");
    }
    #[test]
    fn retired_collection_switch_is_accepted_but_not_advertised() {
        for value in [false, true] {
            let config: crate::markdown_chat::MarkdownChatConfig =
                serde_json::from_value(serde_json::json!({"analyticsEnabled":value})).unwrap();
            assert!(
                serde_json::to_value(config)
                    .unwrap()
                    .get("analyticsEnabled")
                    .is_none()
            );
        }
    }
    #[test]
    fn private_sidecar_has_only_counters_and_opaque_ids() {
        let mut t = tracker();
        t.apply(&send("opaque", BASE, Some("model")));
        t.apply(&tool("epoch:1", BASE + 1, false));
        let bytes = serde_json::to_string(&t.data).unwrap();
        assert!(!bytes.contains("chatgpt.com"));
        assert!(!bytes.contains("CHAT.md"));
        assert!(!bytes.contains("markdown"));
        assert!(!bytes.contains("canonicalUrl"));
    }
    #[test]
    fn rolling_dedup_history_is_bounded() {
        let mut ids = VecDeque::new();
        for i in 0..3000 {
            remember(&mut ids, i.to_string(), 2048);
        }
        assert_eq!(ids.len(), 2048);
        assert_eq!(ids.front().unwrap(), "952");
    }
    #[test]
    fn saving_settings_removes_the_retired_collection_switch() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        let mut config = crate::config::default_config(dir.path().to_owned());
        config.loaded_config_path = Some(path.clone());
        std::fs::write(&path, serde_json::json!({"workDir":dir.path(),"codexMcp":{"enabled":false},"agentChat":{"analyticsEnabled":false}}).to_string()).unwrap();
        let cli = <crate::config::Cli as clap::Parser>::try_parse_from([
            "codexify",
            "--config",
            path.to_str().unwrap(),
        ])
        .unwrap();
        crate::config::validate_config_quiet(&cli).unwrap();
        let initial = crate::global_settings::snapshot(&config).unwrap();
        assert!(
            initial["defaults"]["agentChat"]
                .get("analyticsEnabled")
                .is_none()
        );
        let saved = crate::global_settings::save(
            &config,
            initial["revision"].as_str().unwrap(),
            Some(initial["raw"].as_str().unwrap().into()),
            None,
        )
        .unwrap();
        assert!(
            saved["document"]["agentChat"]
                .get("analyticsEnabled")
                .is_none()
        );
        assert_eq!(saved["restartRequired"], false);
    }
    #[test]
    fn real_buffered_collector_publishes_private_counts_without_automation_files() {
        initialize();
        let dir = tempfile::tempdir().unwrap();
        let chat = dir.path().join("CHAT.md");
        std::fs::write(&chat, b"protected chat").unwrap();
        let now = crate::markdown_chat::now_ms();
        let mut config = crate::config::default_config(dir.path().into());
        config.markdown_chat =
            serde_json::from_value(serde_json::json!({"analyticsEnabled":false})).unwrap();
        let options = Options::from_config(&config);
        sent(
            &options,
            chat.clone(),
            TurnSend {
                action_id: "collector-real-send".into(),
                at_ms: now,
                model: Some("gpt-6-astra".into()),
                effort: Some("max".into()),
                pairing_generation: 1,
                owner_generation: 1,
            },
        );
        let config = crate::config::default_config(dir.path().to_owned());
        let activity = crate::markdown_chat::AgentActivity {
            at_ms: now,
            epoch: "collector-real-tool".into(),
            sequence: 1,
        };
        drop(super::tool(&config, &chat, &activity, "exec_command"));
        enqueue(
            &options,
            chat.clone(),
            now,
            Event::Goal {
                id: "collector-real-goal".into(),
            },
        );
        let deadline = Instant::now() + Duration::from_secs(6);
        loop {
            if let Ok(Some(data)) = load(&chat.with_file_name(FILE)) {
                let t = Tracker::new(data);
                if sum(&t).turns == 1 && sum(&t).tool_calls == 1 && sum(&t).goals == 1 {
                    break;
                }
            }
            assert!(
                Instant::now() < deadline,
                "best-effort worker did not publish fixture counters"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(std::fs::read(&chat).unwrap(), b"protected chat");
        assert!(!chat.with_file_name("automation.json").exists());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(chat.with_file_name(FILE))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o077,
                0
            );
        }
    }
}
