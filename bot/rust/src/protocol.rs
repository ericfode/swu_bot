//! Wire types for spec/stdio-protocol.md (swu-bot-stdio v1: JSON Lines over stdio, one request -> one reply).
//!
//! Unknown fields are ignored and most fields default, so the adapter can add data without breaking this bot.

#![allow(dead_code)] // wire types document the full message, not just what current policies read

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

pub const PROTOCOL: &str = "swu-bot-stdio";
pub const VERSION: u32 = 1;

#[derive(Debug, Deserialize)]
#[serde(tag = "t", rename_all = "lowercase")]
pub enum Request {
    Hello(Hello),
    Decide(Decide),
}

/// Sent at the start of every game; the process may serve several games in a row.
#[derive(Debug, Deserialize)]
pub struct Hello {
    #[serde(default)]
    pub protocol: String,
    pub v: u32,
    #[serde(default)]
    pub bot: String,
    /// Seat this bot plays this game, "p1" or "p2".
    pub you: String,
    /// Drawn from the match RNG; seed the bot's own RNG from it to keep games reproducible.
    #[serde(default)]
    pub seed: u64,
}

#[derive(Debug, Deserialize)]
pub struct Decide {
    #[serde(default)]
    pub seq: u64,
    pub you: String,
    pub prompt: Prompt,
    #[serde(default)]
    pub state: State,
    pub actions: Vec<Action>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Prompt {
    /// Engine promptType (resource, actionWindow, initiative, ...), null for target selection.
    #[serde(default, rename = "type")]
    pub kind: Option<String>,
    /// EnvGame.promptSignature, as recorded in replays.
    #[serde(default)]
    pub signature: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub prompt_title: Option<String>,
    #[serde(default)]
    pub select_card_mode: Option<String>,
    /// Card uuids already selected in a multi-select prompt.
    #[serde(default)]
    pub selected: Vec<String>,
    #[serde(default)]
    pub action_window: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Action {
    #[serde(default)]
    pub i: usize,
    /// button | card | option | displayCard | perCardButton | distribute
    pub kind: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub arg: Option<Value>,
    #[serde(default)]
    pub card_uuid: Option<String>,
    #[serde(default)]
    pub card: Option<CardWire>,
    #[serde(default)]
    pub distribute: Option<Distribute>,
}

/// A `distribute` action: split `amount` damage or healing over `targets`.
#[derive(Debug, Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Distribute {
    /// distributeDamage | distributeIndirectDamage | distributeHealing | ...
    #[serde(default, rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub amount: u32,
    #[serde(default)]
    pub can_distribute_less: bool,
    #[serde(default)]
    pub can_choose_no_targets: bool,
    #[serde(default)]
    pub max_targets: Option<u32>,
    #[serde(default)]
    pub targets: Vec<DistTarget>,
}

#[derive(Debug, Deserialize, Default, Clone)]
pub struct DistTarget {
    pub id: String,
    /// None = uncapped
    #[serde(default)]
    pub cap: Option<u32>,
}

/// One entry of the split a bot may send with a `distribute` action.
#[derive(Debug, Serialize, Clone, PartialEq)]
pub struct DistShare {
    pub id: String,
    pub amount: u32,
}

#[derive(Debug, Deserialize, Clone, Default)]
pub struct CardWire {
    /// Engine card uuid; matches `id` on the cards in `state`.
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub n: Option<String>,
    #[serde(default)]
    pub s: Option<String>,
    #[serde(default)]
    pub zone: Option<String>,
    /// Controlling seat, "p1" or "p2".
    #[serde(default)]
    pub ctl: Option<String>,
    /// Not in protocol v1; used when an adapter sends it.
    #[serde(default)]
    pub cost: Option<i32>,
}

/// The replay snapshot from this seat (spec/replay-format.md), with card uuids and the opponent's hand as a count.
#[derive(Debug, Deserialize, Default)]
pub struct State {
    #[serde(default)]
    pub round: u32,
    #[serde(default)]
    pub phase: Option<String>,
    #[serde(default)]
    pub initiative: Option<String>,
    #[serde(default)]
    pub players: BTreeMap<String, PlayerView>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PlayerView {
    #[serde(default)]
    pub base: BaseView,
    #[serde(default)]
    pub leader: Option<LeaderView>,
    #[serde(default)]
    pub res: Resources,
    #[serde(default)]
    pub hand_count: u32,
    /// Only present for your own seat.
    #[serde(default)]
    pub hand: Option<Vec<CardRef>>,
    #[serde(default)]
    pub deck: u32,
    #[serde(default)]
    pub ground: Vec<UnitView>,
    #[serde(default)]
    pub space: Vec<UnitView>,
}

#[derive(Debug, Deserialize, Default)]
pub struct CardRef {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub n: Option<String>,
    #[serde(default)]
    pub s: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
pub struct LeaderView {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub n: Option<String>,
    #[serde(default)]
    pub s: Option<String>,
    /// 1 once deployed as a unit
    #[serde(default)]
    pub dep: u8,
    #[serde(default)]
    pub x: u8,
}

#[derive(Debug, Deserialize, Default)]
pub struct BaseView {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub n: Option<String>,
    #[serde(default)]
    pub s: Option<String>,
    #[serde(default)]
    pub hp: i32,
    #[serde(default)]
    pub d: i32,
}

#[derive(Debug, Deserialize, Default)]
pub struct Resources {
    #[serde(default)]
    pub ready: u32,
    #[serde(default)]
    pub total: u32,
}

#[derive(Debug, Deserialize, Default)]
pub struct UnitView {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub n: Option<String>,
    #[serde(default)]
    pub p: i32,
    #[serde(default)]
    pub h: i32,
    #[serde(default)]
    pub d: i32,
    #[serde(default)]
    pub s: Option<String>,
    #[serde(default)]
    pub x: Option<u8>,
    #[serde(default)]
    pub sn: Option<u8>,
    /// Upgrades on the unit; `t: 1` for tokens (Shield, Experience, ...).
    #[serde(default)]
    pub u: Vec<UpgradeRef>,
}

#[derive(Debug, Deserialize, Default)]
pub struct UpgradeRef {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub n: Option<String>,
    #[serde(default)]
    pub t: u8,
}

impl UnitView {
    pub fn ready(&self) -> bool {
        self.x != Some(1)
    }

    pub fn sentinel(&self) -> bool {
        self.sn == Some(1)
    }

    pub fn hp_left(&self) -> i32 {
        (self.h - self.d).max(0)
    }

    pub fn shields(&self) -> usize {
        self.u.iter().filter(|u| u.n.as_deref() == Some("Shield")).count()
    }
}

impl State {
    /// A unit in play by card uuid, on either side.
    pub fn unit(&self, id: &str) -> Option<&UnitView> {
        self.players.values().flat_map(|p| p.ground.iter().chain(p.space.iter())).find(|u| u.id == id)
    }

    /// Seat ("p1"/"p2") and arena ("ground"/"space") of a unit in play.
    pub fn unit_at(&self, id: &str) -> Option<(&str, &'static str, &UnitView)> {
        for (seat, p) in &self.players {
            if let Some(u) = p.ground.iter().find(|u| u.id == id) {
                return Some((seat.as_str(), "ground", u));
            }
            if let Some(u) = p.space.iter().find(|u| u.id == id) {
                return Some((seat.as_str(), "space", u));
            }
        }
        None
    }

    /// Seat whose base has this card uuid.
    pub fn base_owner(&self, id: &str) -> Option<&str> {
        self.players.iter().find(|(_, p)| p.base.id == id).map(|(s, _)| s.as_str())
    }
}

impl PlayerView {
    pub fn units(&self) -> impl Iterator<Item = &UnitView> {
        self.ground.iter().chain(self.space.iter())
    }

    pub fn base_left(&self) -> i32 {
        (self.base.hp - self.base.d).max(0)
    }
}

/// The other seat.
pub fn other(seat: &str) -> &'static str {
    if seat == "p1" { "p2" } else { "p1" }
}

#[derive(Debug, Serialize)]
#[serde(tag = "t", rename_all = "lowercase")]
pub enum Reply {
    Ready { v: u32, name: String },
    Act {
        i: usize,
        #[serde(skip_serializing_if = "Option::is_none")]
        distribution: Option<Vec<DistShare>>,
    },
    Error { error: String },
}
