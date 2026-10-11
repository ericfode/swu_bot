use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const MAX_CARDS: usize = 256;
pub const MAX_ZONE: usize = 64;
pub type CardId = u16;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Seat {
    P1,
    P2,
}
impl Seat {
    pub fn other(self) -> Self {
        if self == Self::P1 {
            Self::P2
        } else {
            Self::P1
        }
    }
    pub fn index(self) -> usize {
        if self == Self::P1 {
            0
        } else {
            1
        }
    }
    pub fn as_str(self) -> &'static str {
        if self == Self::P1 {
            "p1"
        } else {
            "p2"
        }
    }
    pub fn parse(s: &str) -> Result<Self, String> {
        match s {
            "p1" => Ok(Self::P1),
            "p2" => Ok(Self::P2),
            _ => Err(format!("invalid seat {s}")),
        }
    }
}
impl Default for Seat {
    fn default() -> Self {
        Self::P1
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Zone {
    pub ids: [CardId; MAX_ZONE],
    pub len: u8,
}
impl Default for Zone {
    fn default() -> Self {
        Self {
            ids: [0; MAX_ZONE],
            len: 0,
        }
    }
}
impl Zone {
    pub fn as_slice(&self) -> &[CardId] {
        &self.ids[..self.len as usize]
    }
    pub fn contains(&self, id: CardId) -> bool {
        self.as_slice().contains(&id)
    }
    pub fn push(&mut self, id: CardId) -> Result<(), String> {
        if self.len as usize == MAX_ZONE {
            return Err("zone capacity exceeded (64 cards)".into());
        }
        self.ids[self.len as usize] = id;
        self.len += 1;
        Ok(())
    }
    pub fn remove(&mut self, id: CardId) -> bool {
        if let Some(i) = self.as_slice().iter().position(|&c| c == id) {
            self.ids.copy_within(i + 1..self.len as usize, i);
            self.len -= 1;
            self.ids[self.len as usize] = 0;
            true
        } else {
            false
        }
    }
    pub fn pop_front(&mut self) -> Option<CardId> {
        let id = *self.as_slice().first()?;
        self.remove(id);
        Some(id)
    }
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Card {
    pub def: u16,
    pub present: bool,
    pub owner: Seat,
    pub damage: u16,
    pub exhausted: bool,
    pub deployed: bool,
    pub epic_used: bool,
    pub shield: CardId,
}
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Player {
    pub base: CardId,
    pub leader: CardId,
    pub hand: Zone,
    pub deck: Zone,
    pub resources: Zone,
    pub discard: Zone,
    pub ground: Zone,
    pub space: Zone,
    pub out: bool,
}

/// Every engine prompt is retained, including confirmation and cancellation prompts.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    #[default]
    Window,
    LeaderMenu,
    AttackTarget,
    VaderBase,
    SatineHeal,
    NoEffect,
    Resource,
    Unique,
    Ambush,
    TriggerOrder,
    ShieldOrder,
    Terminal,
}

/// All mutable game data is inline. Copying a position neither allocates nor shares mutable data.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct State {
    pub cards: [Card; MAX_CARDS],
    pub next_id: CardId,
    pub players: [Player; 2],
    pub round: u16,
    pub regroup: bool,
    pub initiative: Seat,
    pub initiative_claimed: bool,
    pub prev_passed: bool,
    pub active: Seat,
    pub decision: Decision,
    pub source: CardId,
    pub target: CardId,
    pub ambush: bool,
    pub after_attack_triggers: u8,
    pub pending_triggers: u8,
    pub trigger_context: u8,
    pub resource_done: [bool; 2],
    pub resource_selected: [CardId; 2],
    /// 0 ongoing, 1 p1, 2 p2, 3 draw.
    pub outcome: u8,
}
impl Default for State {
    fn default() -> Self {
        Self {
            cards: [Card::default(); MAX_CARDS],
            next_id: 1,
            players: [Player::default(); 2],
            round: 1,
            regroup: false,
            initiative: Seat::P1,
            initiative_claimed: false,
            prev_passed: false,
            active: Seat::P1,
            decision: Decision::Window,
            source: 0,
            target: 0,
            ambush: false,
            after_attack_triggers: 0,
            pending_triggers: 0,
            trigger_context: 0,
            resource_done: [false; 2],
            resource_selected: [0; 2],
            outcome: 0,
        }
    }
}
impl State {
    pub fn actor(&self) -> Option<Seat> {
        (!self.is_terminal()).then_some(self.active)
    }
    pub fn is_action_window(&self) -> bool {
        self.decision == Decision::Window && !self.is_terminal()
    }
    pub fn is_terminal(&self) -> bool {
        self.outcome != 0
    }
    pub fn winner(&self) -> Option<Seat> {
        match self.outcome {
            1 => Some(Seat::P1),
            2 => Some(Seat::P2),
            _ => None,
        }
    }
    pub fn card(&self, id: CardId) -> &Card {
        &self.cards[id as usize]
    }
    pub fn card_mut(&mut self, id: CardId) -> &mut Card {
        &mut self.cards[id as usize]
    }
    pub fn player(&self, seat: Seat) -> &Player {
        &self.players[seat.index()]
    }
    pub fn player_mut(&mut self, seat: Seat) -> &mut Player {
        &mut self.players[seat.index()]
    }
    /// Zobrist hashing over semantic features. SplitMix derives stable independent keys;
    /// no padding bytes, pointer values or allocation order enter the hash.
    pub fn zobrist(&self) -> u64 {
        fn key(i: u64, v: u64) -> u64 {
            let mut z = i.wrapping_mul(0x9e3779b97f4a7c15) ^ v.wrapping_mul(0xd6e8feb86659fd93);
            z = (z ^ (z >> 30)).wrapping_mul(0xbf58476d1ce4e5b9);
            z = (z ^ (z >> 27)).wrapping_mul(0x94d049bb133111eb);
            z ^ (z >> 31)
        }
        let mut h = 0;
        let mut i = 0;
        let mut put = |v: u64| {
            i += 1;
            h ^= key(i, v);
        };
        put(self.next_id as u64);
        put(self.round as u64);
        put(self.regroup as u64);
        put(self.initiative.index() as u64);
        put(self.initiative_claimed as u64);
        put(self.prev_passed as u64);
        put(self.active.index() as u64);
        put(self.decision as u64);
        put(self.source as u64);
        put(self.target as u64);
        put(self.ambush as u64);
        put(self.after_attack_triggers as u64);
        put(self.pending_triggers as u64);
        put(self.trigger_context as u64);
        put(self.outcome as u64);
        for n in 0..2 {
            put(self.resource_done[n] as u64);
            put(self.resource_selected[n] as u64);
        }
        for (idx, c) in self
            .cards
            .iter()
            .enumerate()
            .take(self.next_id as usize)
            .skip(1)
        {
            put(idx as u64);
            put(c.def as u64
                | ((c.present as u64) << 16)
                | ((c.owner.index() as u64) << 17)
                | ((c.damage as u64) << 18)
                | ((c.exhausted as u64) << 34)
                | ((c.deployed as u64) << 35)
                | ((c.epic_used as u64) << 36)
                | ((c.shield as u64) << 37));
        }
        for p in &self.players {
            put(p.base as u64);
            put(p.leader as u64);
            put(p.out as u64);
            for zone in [
                &p.hand,
                &p.deck,
                &p.resources,
                &p.discard,
                &p.ground,
                &p.space,
            ] {
                put(zone.len as u64);
                for &id in zone.as_slice() {
                    put(id as u64);
                }
            }
        }
        h
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Action {
    pub kind: String,
    pub card: Option<String>,
    pub arg: Option<Value>,
    pub method: Option<String>,
    pub label: String,
}
impl Action {
    pub fn button(label: impl Into<String>, arg: impl Into<Value>) -> Self {
        Self {
            kind: "button".into(),
            card: None,
            arg: Some(arg.into()),
            method: None,
            label: label.into(),
        }
    }
    pub fn card(id: CardId, label: impl Into<String>) -> Self {
        Self {
            kind: "card".into(),
            card: Some(format!("c{}", id - 1)),
            arg: None,
            method: None,
            label: label.into(),
        }
    }
    pub fn key(&self) -> String {
        json!([self.kind, self.card, self.arg, self.method, self.label]).to_string()
    }
    pub fn id(&self) -> Option<CardId> {
        self.card
            .as_ref()?
            .strip_prefix('c')?
            .parse::<CardId>()
            .ok()?
            .checked_add(1)
    }
}
