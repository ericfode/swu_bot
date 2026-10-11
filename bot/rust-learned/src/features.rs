//! Turns one `decide` message (prompt, state, actions) into fixed-size numbers for the model.
//!
//! Everything is from the deciding seat's point of view ("me" / "opp"), so one model plays both seats.
//! The same code runs at training time (on recorded trajectories) and at play time (on live messages),
//! so there is no train/play skew.

use crate::cards::{CardDb, CardInfo, KEYWORDS};
use serde_json::Value;

/// Numbers per side in the state vector.
pub const SIDE: usize = 20;
/// State vector length: two sides, my hand summary, and global/prompt context.
pub const STATE_DIM: usize = 2 * SIDE + HAND + GLOBAL;
const HAND: usize = 8;
const GLOBAL: usize = 1 + 3 + 3 + PROMPT_TYPES.len() + 1 + 3 + 1 + 1 + 2;
/// Action vector length.
pub const ACTION_DIM: usize = KINDS.len() + BUTTONS.len() + ZONES.len() + 2 + CARD + BOARD + 4 + 2;
const CARD: usize = 11 + KEYWORDS.len();
const BOARD: usize = 7;
/// Buckets for the hashed card / label identity embedding.
pub const ID_BUCKETS: usize = 2048;
/// The part of the state the world model predicts: both sides' board and resources.
pub const WORLD_DIM: usize = 2 * SIDE;

const PROMPT_TYPES: [&str; 10] = [
    "actionWindow",
    "resource",
    "initiative",
    "triggerWindow",
    "optionalTrigger",
    "distributeAmongTargets",
    "displayCards",
    "number",
    "mulligan",
    "other",
];
const KINDS: [&str; 6] = ["button", "card", "option", "displayCard", "perCardButton", "distribute"];
const BUTTONS: [&str; 12] =
    ["pass", "cancel", "done", "keep", "mulligan", "0", "1", "yes", "no", "claim", "skip", "other"];
const ZONES: [&str; 8] = ["hand", "groundArena", "spaceArena", "base", "discard", "resource", "leader", "other"];

pub struct Encoded {
    pub state: Vec<f32>,
    /// One row of ACTION_DIM per legal action.
    pub actions: Vec<Vec<f32>>,
    /// Hashed identity (card set code or button label) per legal action.
    pub ids: Vec<i64>,
}

fn f(v: &Value, k: &str) -> f32 {
    v.get(k).and_then(|x| x.as_f64()).unwrap_or(0.0) as f32
}

fn arr<'a>(v: &'a Value, k: &str) -> &'a [Value] {
    v.get(k).and_then(|x| x.as_array()).map(|a| a.as_slice()).unwrap_or(&[])
}

fn units(side: &Value) -> impl Iterator<Item = &Value> {
    arr(side, "ground").iter().chain(arr(side, "space").iter())
}

fn side_features(side: &Value, out: &mut Vec<f32>) {
    let base = side.get("base").cloned().unwrap_or(Value::Null);
    let base_hp = f(&base, "hp").max(1.0);
    let base_left = (f(&base, "hp") - f(&base, "d")).max(0.0);
    let res = side.get("res").cloned().unwrap_or(Value::Null);
    let leader = side.get("leader").cloned().unwrap_or(Value::Null);
    let (mut pow_g, mut pow_s, mut hp_left, mut exhausted, mut ready_pow, mut sentinels, mut shields, mut ups) =
        (0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
    for u in arr(side, "ground") {
        pow_g += f(u, "p");
    }
    for u in arr(side, "space") {
        pow_s += f(u, "p");
    }
    let mut n = 0.0;
    for u in units(side) {
        n += 1.0;
        hp_left += (f(u, "h") - f(u, "d")).max(0.0);
        if f(u, "x") > 0.0 {
            exhausted += 1.0;
        } else {
            ready_pow += f(u, "p");
        }
        sentinels += f(u, "sn");
        for up in arr(u, "u") {
            if up.get("n").and_then(|x| x.as_str()) == Some("Shield") {
                shields += 1.0;
            } else {
                ups += 1.0;
            }
        }
    }
    out.extend_from_slice(&[
        base_left / 30.0,
        base_left / base_hp,
        (base_left <= 10.0) as i32 as f32,
        f(&res, "ready") / 10.0,
        f(&res, "total") / 10.0,
        f(side, "handCount") / 10.0,
        f(side, "deck") / 50.0,
        arr(side, "discard").len() as f32 / 30.0,
        arr(side, "ground").len() as f32 / 6.0,
        arr(side, "space").len() as f32 / 6.0,
        pow_g / 20.0,
        pow_s / 20.0,
        hp_left / 30.0,
        exhausted / 6.0,
        ready_pow / 20.0,
        sentinels / 3.0,
        shields / 3.0,
        ups / 3.0,
        f(&leader, "dep"),
        f(&leader, "x"),
    ]);
    debug_assert_eq!(n >= 0.0, true);
}

fn card_info<'a>(db: &'a CardDb, c: &Value) -> Option<&'a CardInfo> {
    db.get(c.get("s").and_then(|s| s.as_str()))
}

fn prompt_type(prompt: &Value) -> usize {
    let t = prompt.get("type").and_then(|t| t.as_str()).unwrap_or("");
    let title = prompt.get("title").and_then(|t| t.as_str()).unwrap_or("").to_lowercase();
    if title.contains("mulligan") {
        return 8;
    }
    PROMPT_TYPES.iter().position(|p| *p == t).unwrap_or(PROMPT_TYPES.len() - 1)
}

/// Stable string hash (FNV-1a), so ids agree between Rust, Python and runs.
pub fn hash_id(s: &str) -> i64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    (h % ID_BUCKETS as u64) as i64
}

/// Encodes a `decide` body: `{you, prompt, state, actions}`.
pub fn encode(msg: &Value, db: &CardDb) -> Encoded {
    let you = msg.get("you").and_then(|x| x.as_str()).unwrap_or("p1");
    let opp = if you == "p1" { "p2" } else { "p1" };
    let state = &msg["state"];
    let me = &state["players"][you];
    let them = &state["players"][opp];
    let prompt = &msg["prompt"];

    let mut s = Vec::with_capacity(STATE_DIM);
    side_features(me, &mut s);
    side_features(them, &mut s);

    // my hand, with printed costs from the card data
    let ready = f(&me["res"], "ready");
    let (mut cost, mut units_h, mut events, mut upgrades, mut playable, mut min_cost, mut power) =
        (0.0, 0.0, 0.0, 0.0, 0.0, 99.0f32, 0.0);
    for c in arr(me, "hand") {
        if let Some(i) = card_info(db, c) {
            cost += i.cost;
            units_h += i.unit as i32 as f32;
            events += i.event as i32 as f32;
            upgrades += i.upgrade as i32 as f32;
            playable += (i.cost <= ready) as i32 as f32;
            min_cost = min_cost.min(i.cost);
            power += i.power;
        }
    }
    let nh = arr(me, "hand").len() as f32;
    s.extend_from_slice(&[
        cost / 30.0,
        units_h / 5.0,
        events / 5.0,
        upgrades / 5.0,
        playable / 5.0,
        if nh > 0.0 { min_cost.min(10.0) / 10.0 } else { 1.0 },
        power / 20.0,
        nh / 10.0,
    ]);

    // global and prompt context
    s.push(f(state, "round") / 20.0);
    let phase = state.get("phase").and_then(|p| p.as_str()).unwrap_or("");
    for p in ["setup", "action", "regroup"] {
        s.push((phase == p) as i32 as f32);
    }
    let init = state.get("initiative").and_then(|p| p.as_str());
    s.push((init == Some(you)) as i32 as f32);
    s.push((init == Some(opp)) as i32 as f32);
    s.push(init.is_none() as i32 as f32);
    let pt = prompt_type(prompt);
    for k in 0..PROMPT_TYPES.len() {
        s.push((k == pt) as i32 as f32);
    }
    s.push(prompt.get("actionWindow").and_then(|x| x.as_bool()).unwrap_or(false) as i32 as f32);
    let mode = prompt.get("selectCardMode").and_then(|x| x.as_str());
    s.push((mode == Some("single")) as i32 as f32);
    s.push((mode == Some("multiple")) as i32 as f32);
    s.push(mode.is_none() as i32 as f32);
    s.push(arr(prompt, "selected").len() as f32 / 5.0);
    let actions = arr(msg, "actions");
    s.push((actions.len() as f32).min(30.0) / 30.0);
    // material and base race, the two things a human looks at first
    s.push(s[0] - s[SIDE]);
    s.push(s[12] - s[SIDE + 12] + s[10] + s[11] - s[SIDE + 10] - s[SIDE + 11]);
    debug_assert_eq!(s.len(), STATE_DIM);

    // index the board by card id so a clicked unit gets its live stats
    let mut board: std::collections::HashMap<&str, (&Value, bool)> = std::collections::HashMap::new();
    for (side, mine) in [(me, true), (them, false)] {
        for u in units(side) {
            if let Some(id) = u.get("id").and_then(|x| x.as_str()) {
                board.insert(id, (u, mine));
            }
        }
    }

    let mut rows = Vec::with_capacity(actions.len());
    let mut ids = Vec::with_capacity(actions.len());
    for a in actions {
        let mut r = vec![0.0f32; ACTION_DIM];
        let mut o = 0;
        let kind = a.get("kind").and_then(|x| x.as_str()).unwrap_or("");
        if let Some(k) = KINDS.iter().position(|x| *x == kind) {
            r[o + k] = 1.0;
        }
        o += KINDS.len();
        let label = a.get("label").and_then(|x| x.as_str()).unwrap_or("").to_lowercase();
        let arg = match a.get("arg") {
            Some(Value::String(x)) => x.to_lowercase(),
            Some(Value::Number(n)) => n.to_string(),
            _ => String::new(),
        };
        if kind == "button" || kind == "perCardButton" {
            let b = BUTTONS
                .iter()
                .position(|b| arg == *b || label == *b || (b.len() > 2 && label.starts_with(b)))
                .unwrap_or(BUTTONS.len() - 1);
            r[o + b] = 1.0;
        }
        o += BUTTONS.len();
        let card = a.get("card");
        let mut code: Option<String> = None;
        if let Some(c) = card {
            let zone = c.get("zone").and_then(|x| x.as_str()).unwrap_or("other");
            let z = ZONES.iter().position(|x| *x == zone).unwrap_or(ZONES.len() - 1);
            r[o + z] = 1.0;
            code = c.get("s").and_then(|x| x.as_str()).map(String::from);
        }
        o += ZONES.len();
        if let Some(c) = card {
            let ctl = c.get("ctl").and_then(|x| x.as_str());
            r[o] = (ctl == Some(you)) as i32 as f32;
            r[o + 1] = (ctl == Some(opp)) as i32 as f32;
        }
        o += 2;
        if let Some(i) = card.and_then(|c| card_info(db, c)) {
            let k = [
                i.cost / 10.0,
                i.power / 10.0,
                i.hp / 10.0,
                i.unit as i32 as f32,
                i.event as i32 as f32,
                i.upgrade as i32 as f32,
                i.leader as i32 as f32,
                i.base as i32 as f32,
                i.token as i32 as f32,
                i.space as i32 as f32,
                (i.cost <= ready) as i32 as f32,
            ];
            r[o..o + k.len()].copy_from_slice(&k);
            for b in 0..KEYWORDS.len() {
                r[o + 11 + b] = ((i.keywords >> b) & 1) as f32;
            }
        }
        o += CARD;
        let id = card.and_then(|c| c.get("id")).and_then(|x| x.as_str()).or_else(|| a.get("cardUuid").and_then(|x| x.as_str()));
        if let Some((u, mine)) = id.and_then(|id| board.get(id)) {
            let left = (f(u, "h") - f(u, "d")).max(0.0);
            r[o..o + BOARD].copy_from_slice(&[
                1.0,
                *mine as i32 as f32,
                f(u, "p") / 10.0,
                left / 10.0,
                f(u, "x"),
                f(u, "sn"),
                arr(u, "u").len() as f32 / 3.0,
            ]);
        }
        o += BOARD;
        if let Some(d) = a.get("distribute") {
            r[o] = f(d, "amount") / 10.0;
            r[o + 1] = arr(d, "targets").len() as f32 / 10.0;
        }
        if kind == "option" {
            if let Ok(n) = arg.parse::<f32>() {
                r[o + 2] = n / 10.0;
            }
        }
        r[o + 3] = (mode == Some("multiple") && kind == "card") as i32 as f32;
        o += 4;
        // targets on the base matter a lot (attacks on the opponent's base)
        let base_id = |side: &Value| side["base"].get("id").and_then(|x| x.as_str()).map(String::from);
        r[o] = (id.is_some() && id.map(String::from) == base_id(them)) as i32 as f32;
        r[o + 1] = (id.is_some() && id.map(String::from) == base_id(me)) as i32 as f32;
        o += 2;
        debug_assert_eq!(o, ACTION_DIM);
        rows.push(r);
        let key = match code {
            Some(c) => format!("card:{c}"),
            None => format!("{kind}:{}", if arg.is_empty() { label.clone() } else { arg.clone() }),
        };
        ids.push(hash_id(&key));
    }
    Encoded { state: s, actions: rows, ids }
}

/// A hand-written evaluation of the board part of a state vector (the "heuristic" knob).
/// Positive is good for me. Uses only the WORLD_DIM block, so it also scores world-model predictions.
pub fn heuristic(w: &[f32]) -> f32 {
    let side = |o: usize| {
        let base = w[o] * 30.0;
        let units = w[o + 10] * 20.0 + w[o + 11] * 20.0 + w[o + 12] * 30.0 * 0.8;
        let cards = w[o + 5] * 10.0 * 1.5 + w[o + 4] * 10.0 * 1.2;
        let danger = if base <= 12.0 { (12.0 - base).powi(2) / 6.0 } else { 0.0 };
        base * 0.9 + units + cards - danger + w[o + 16] * 3.0 * 2.0
    };
    (side(0) - side(SIDE)) / 30.0
}
