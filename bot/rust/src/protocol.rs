//! Wire types for spec/stdio-protocol.md (swu-bot-stdio v1) and spec/protocol.md (v2: adds `over` and simulations).
//!
//! Unknown fields are ignored and most fields default, so the adapter can add data without breaking this bot.

#![allow(dead_code)] // wire types document the full message, not just what current policies read

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

pub const PROTOCOL: &str = "swu-bot-stdio";
/// `hello.v` is always 1; the version actually spoken is picked from `hello.versions` in `ready`.
pub const VERSION: u32 = 1;
pub const VERSION_2: u32 = 2;

#[derive(Debug, Deserialize, Clone)]
#[serde(tag = "t", rename_all = "lowercase")]
pub enum Request {
    Hello(Hello),
    Decide(Decide),
    /// v2: the game ended; reply `ok`.
    Over(Over),
    /// v2: reply to a `sim` request.
    Simulated(Simulated),
    /// v2 on transports without end-of-file: stop, no reply.
    Bye,
}

/// Sent at the start of every game; the process may serve several games in a row.
#[derive(Debug, Deserialize, Clone, Default)]
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
    /// v2: protocol versions the referee speaks (absent from a v1 referee).
    #[serde(default)]
    pub versions: Vec<u32>,
    /// v2: both deck lists (they are open): this seat's and the opponent's.
    #[serde(default)]
    pub deck: Option<DeckList>,
    #[serde(default)]
    pub opponent: Option<DeckList>,
}

/// A deck list from `hello`: set codes with counts, in the order the engine numbers the cards.
#[derive(Debug, Deserialize, Clone, Default)]
pub struct DeckList {
    #[serde(default)]
    pub leader: DeckEntry,
    #[serde(default)]
    pub base: DeckEntry,
    #[serde(default)]
    pub deck: Vec<DeckEntry>,
}

#[derive(Debug, Deserialize, Clone, Default)]
pub struct DeckEntry {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub count: u32,
}

/// v2 `over`: the game ended.
#[derive(Debug, Deserialize, Clone, Default)]
pub struct Over {
    #[serde(default)]
    pub winner: Option<String>,
    #[serde(default)]
    pub outcome: Option<String>,
}

/// v2 reply to a `sim` request: a position (`actor`, `prompt`, `state`, `actions`), a finished game (`over`) or `error`.
#[derive(Debug, Deserialize, Clone, Default)]
pub struct Simulated {
    #[serde(default)]
    pub op: String,
    #[serde(default)]
    pub actor: Option<String>,
    #[serde(default)]
    pub prompt: Option<Prompt>,
    #[serde(default)]
    pub state: Option<State>,
    #[serde(default)]
    pub actions: Option<Vec<Action>>,
    #[serde(default)]
    pub over: Option<Over>,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Debug, Deserialize, Clone, Default)]
pub struct Decide {
    #[serde(default)]
    pub seq: u64,
    pub you: String,
    pub prompt: Prompt,
    #[serde(default)]
    pub state: State,
    pub actions: Vec<Action>,
    /// v2: `sim` requests are allowed before this decision's `act`.
    #[serde(default)]
    pub sim: bool,
    /// v2: time for the `act` in milliseconds, simulations included.
    #[serde(default)]
    pub ms: Option<u64>,
}

#[derive(Debug, Deserialize, Default, Clone)]
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

#[derive(Debug, Deserialize, Clone, Default)]
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
#[derive(Debug, Deserialize, Default, Clone)]
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

#[derive(Debug, Deserialize, Default, Clone)]
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
    pub discard: Vec<CardRef>,
    /// Own seat only: resources, `x: 1` when exhausted.
    #[serde(default)]
    pub resources: Option<Vec<ResourceRef>>,
    /// Action phase: 1 when the player passed its last action.
    #[serde(default)]
    pub passed: u8,
    /// Action phase: 1 when the player is done for the phase (it claimed the initiative).
    #[serde(default)]
    pub out: u8,
    #[serde(default)]
    pub ground: Vec<UnitView>,
    #[serde(default)]
    pub space: Vec<UnitView>,
}

#[derive(Debug, Deserialize, Default, Clone)]
pub struct CardRef {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub n: Option<String>,
    #[serde(default)]
    pub s: Option<String>,
}

#[derive(Debug, Deserialize, Default, Clone)]
pub struct ResourceRef {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub n: Option<String>,
    #[serde(default)]
    pub s: Option<String>,
    #[serde(default)]
    pub x: u8,
}

#[derive(Debug, Deserialize, Default, Clone)]
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
    /// 1 once its deploy (epic action) is used
    #[serde(default)]
    pub epic: u8,
}

#[derive(Debug, Deserialize, Default, Clone)]
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

#[derive(Debug, Deserialize, Default, Clone)]
pub struct Resources {
    #[serde(default)]
    pub ready: u32,
    #[serde(default)]
    pub total: u32,
}

#[derive(Debug, Deserialize, Default, Clone)]
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

#[derive(Debug, Deserialize, Default, Clone)]
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
    Ready {
        v: u32,
        name: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        sim: Option<bool>,
    },
    /// The split is `distribution` in v1 and `split` in v2.
    Act {
        i: usize,
        #[serde(skip_serializing_if = "Option::is_none")]
        distribution: Option<Vec<DistShare>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        split: Option<Vec<DistShare>>,
    },
    /// v2: play ahead on a private copy of the game (`op`: begin | act | end).
    Sim {
        op: &'static str,
        #[serde(skip_serializing_if = "Option::is_none")]
        deal: Option<u32>,
        #[serde(skip_serializing_if = "Option::is_none")]
        i: Option<usize>,
        #[serde(skip_serializing_if = "Option::is_none")]
        split: Option<Vec<DistShare>>,
    },
    Ok,
    Error { error: String },
}
