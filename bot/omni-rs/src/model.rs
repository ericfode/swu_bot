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

/// Global unit entry order in one arena, independent of controller. Unit-only
/// capacity follows the existing whole-card bound, not a per-player zone bound.
#[derive(Debug,Clone,Copy,PartialEq,Eq)]
pub struct ArenaOrder {pub ids:[CardId;MAX_CARDS],pub len:u16}
impl Default for ArenaOrder {fn default()->Self {Self {ids:[0;MAX_CARDS],len:0}}}
impl ArenaOrder {
    pub fn as_slice(&self)->&[CardId] {&self.ids[..self.len as usize]}
    pub fn push(&mut self,id:CardId)->Result<(),String> {
        if id==0 || self.as_slice().contains(&id) {return Err("duplicate/invalid arena unit order entry".into());}
        if self.len as usize>=MAX_CARDS {return Err("global arena unit order capacity exceeded".into());}
        self.ids[self.len as usize]=id;self.len+=1;Ok(())
    }
    pub fn remove(&mut self,id:CardId) {
        if let Some(i)=self.as_slice().iter().position(|v|*v==id) {self.ids.copy_within(i+1..self.len as usize,i);self.len-=1;self.ids[self.len as usize]=0;}
    }
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Card {
    pub def: u16,
    pub present: bool,
    pub owner: Seat,
    pub damage: u16,
    pub phase_power: i32,
    pub phase_hp: i32,
    pub phase_keyword_values: [u16; 2],
    pub phase_keyword_presence: u8,
    pub phase_lost_keywords: u8,
    /// Current phase play/deploy/create qualification, independent of live Hidden.
    pub hidden_state: u8,
    pub exhausted: bool,
    pub deployed: bool,
    pub epic_used: bool,
    pub shield: CardId,
    pub experience: CardId,
    /// Token linked-list pointer; only token cards use it.
    pub next_token: CardId,
    pub parent: CardId,
    pub upgrades: CardId,
    pub next_upgrade: CardId,
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
    pub force_id: CardId,
    pub force_held: bool,
}

/// Every engine prompt is retained, including confirmation and cancellation prompts.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    #[default]
    Window,
    LeaderMenu,
    AttackTarget,
    UpgradeTarget,
    VaderBase,
    SatineHeal,
    NoEffect,
    Resource,
    Unique,
    Ambush,
    TriggerOrder,
    ShieldOrder,
    AbilityMenu,
    AbilityTarget,
    AbilityOptional,
    AbilityNoEffect,
    AbilityDistribute,
    AbilityGroupShield,
    AbilityDiscard,
    DeathPlayer,
    DeathOrder,
    DeathBatch,
    Terminal,
}

/// Ordered target context retained across suspended event generation.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Selection { pub ids: [CardId; 3], pub len: u8 }
impl Selection {
    pub fn one(id: CardId) -> Self { Self { ids: [id, 0, 0], len: u8::from(id != 0) } }
    pub fn toggle(&mut self, id: CardId) {
        if let Some(i) = self.ids[..self.len as usize].iter().position(|v| *v == id) {
            for j in i..self.len as usize - 1 { self.ids[j] = self.ids[j+1]; }
            self.len -= 1; self.ids[self.len as usize] = 0;
        } else { self.ids[self.len as usize] = id; self.len += 1; }
    }
}
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct PreparedEvent {
    pub op: u16, pub target: CardId, pub amount: u16,
    pub power: i32, pub hp: i32, pub token: CardId,
}
/// Uniform arena damage retains one ordered recipient and Shield context per event.
/// Both IDs are checked against the model's 256-card domain before compact storage.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct UniformDamageRecord { pub target: u8, pub shield: u8 }
impl UniformDamageRecord {
    pub fn new(target:CardId,shield:CardId)->Result<Self,String> {
        if target==0 {return Err("uniform damage requires a real recipient".into());}
        Ok(Self {target:u8::try_from(target).map_err(|_|"uniform damage recipient exceeds card domain")?,
            shield:u8::try_from(shield).map_err(|_|"uniform damage Shield exceeds card domain")?})
    }
    pub fn target(self)->CardId {self.target as CardId}
    pub fn shield(self)->CardId {self.shield as CardId}
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UniformDamageState {
    pub records:[UniformDamageRecord;MAX_CARDS], pub prevented:[u64;4],
    pub count:u16, pub active:bool,
}
impl Default for UniformDamageState {
    fn default()->Self {Self {records:[UniformDamageRecord::default();MAX_CARDS],prevented:[0;4],count:0,active:false}}
}
impl UniformDamageState {
    pub fn is_prevented(&self,index:usize)->bool {self.prevented[index/64]&(1u64<<(index%64))!=0}
    pub fn prevent(&mut self,index:usize) {self.prevented[index/64]|=1u64<<(index%64);}
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EventGroupState {
    pub active: bool, pub resolving: bool, pub replacement_done: bool, pub pc: u16, pub count: u8,
    pub discard_count:u8, pub discard_owner:Seat,
    pub shield_mask:u8, pub shield_count:u8, pub shield_priority:u8, pub initiator:Seat,
    pub shield_stash:[CardId;MAX_CARDS], pub shield_stash_len:u8,
    pub context: Selection, pub picks: Selection,
    pub stack: [Selection; 8], pub depth: u8,
    pub records: [PreparedEvent; 32],
    pub uniform_damage: UniformDamageState,
}
impl Default for EventGroupState {
    fn default() -> Self { Self { active:false, resolving:false, replacement_done:false, pc:0, count:0, discard_count:0, discard_owner:Seat::P1, shield_mask:0, shield_count:0, shield_priority:0, initiator:Seat::P1, shield_stash:[0;MAX_CARDS], shield_stash_len:0,
        context:Selection::default(), picks:Selection::default(), stack:[Selection::default();8], depth:0,
        records:[PreparedEvent::default();32], uniform_damage:UniformDamageState::default() } }
}
pub const MAX_DEATH_TRIGGERS: usize = 64;
pub const MAX_DEATH_DEPTH: usize = 8;
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct DeathTrigger { pub source: CardId, pub program: u16, pub player: Seat, pub after_pc: u8, pub defer_depth: u8, pub keyword: u8 }
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DeathWindow {
    pub entries: [DeathTrigger; MAX_DEATH_TRIGGERS], pub len: u8,
    pub initiator: Seat, pub player: Seat, pub player_chosen: bool,
    pub group_program: u16, pub group_source: CardId, pub group_keyword:u8, pub resolve_all: bool,
}
impl Default for DeathWindow {
    fn default() -> Self { Self { entries:[DeathTrigger::default();MAX_DEATH_TRIGGERS], len:0,
        initiator:Seat::P1, player:Seat::P1, player_chosen:false,
        group_program:0, group_source:0, group_keyword:0, resolve_all:false } }
}
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ResolutionContext {
    pub active: Seat,
    pub decision: Decision,
    pub source: CardId,
    pub target: CardId,
    pub ambush: bool,
    pub after_attack_triggers: u8,
    pub attack_restore: u16,
    pub attack_source: CardId,
    pub attack_defender: CardId,
    pub attack_shield_opponent_first: bool,
    pub pending_triggers: u8,
    pub trigger_context: u8,
    pub pending_programs: u16,
    pub after_attack_programs: u16,
    pub ability_program: u16,
    pub ability_pc: u8,
    pub ability_target: CardId,
    pub ability_selection: Selection,
    pub ability_result: u16,
    pub ability_succeeded: bool,
    pub ability_return: u8,
    pub ability_committed: bool,
}
impl ResolutionContext {
    pub fn capture(s:&State)->Self { Self { active:s.active, decision:s.decision, source:s.source, target:s.target, ambush:s.ambush, after_attack_triggers:s.after_attack_triggers, attack_restore:s.attack_restore, attack_source:s.attack_source,attack_defender:s.attack_defender, attack_shield_opponent_first:s.attack_shield_opponent_first, pending_triggers:s.pending_triggers, trigger_context:s.trigger_context, pending_programs:s.pending_programs, after_attack_programs:s.after_attack_programs, ability_program:s.ability_program, ability_pc:s.ability_pc, ability_target:s.ability_target, ability_selection:s.ability_selection, ability_result:s.ability_result, ability_succeeded:s.ability_succeeded, ability_return:s.ability_return, ability_committed:s.ability_committed } }
    pub fn restore(self,s:&mut State) { s.active=self.active; s.decision=self.decision; s.source=self.source; s.target=self.target; s.ambush=self.ambush; s.after_attack_triggers=self.after_attack_triggers; s.attack_restore=self.attack_restore; s.attack_source=self.attack_source;s.attack_defender=self.attack_defender; s.attack_shield_opponent_first=self.attack_shield_opponent_first; s.pending_triggers=self.pending_triggers; s.trigger_context=self.trigger_context; s.pending_programs=self.pending_programs; s.after_attack_programs=self.after_attack_programs; s.ability_program=self.ability_program; s.ability_pc=self.ability_pc; s.ability_target=self.ability_target; s.ability_selection=self.ability_selection; s.ability_result=self.ability_result; s.ability_succeeded=self.ability_succeeded; s.ability_return=self.ability_return; s.ability_committed=self.ability_committed; }
}
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct DeathFrame { pub context: ResolutionContext, pub window: DeathWindow, pub resume: u8 }

/// All mutable game data is inline. Copying a position neither allocates nor shares mutable data.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct State {
    pub death_pending: DeathWindow,
    pub death_window: DeathWindow,
    pub death_frames: [DeathFrame; MAX_DEATH_DEPTH],
    pub death_depth: u8,
    pub cards: [Card; MAX_CARDS],
    pub next_id: CardId,
    pub players: [Player; 2],
    pub arena_unit_order:[ArenaOrder;2],
    /// False only for immutable legacy imports without ordinary upgrades.
    pub arena_order_exact:bool,
    pub hidden_history_exact:bool,
    pub force_state_exact:bool,
    pub round: u16,
    pub regroup: bool,
    pub initiative: Seat,
    pub initiative_claimed: bool,
    pub prev_passed: bool,
    pub active: Seat,
    /// Action-phase priority is distinct from the owner of a prompted trigger.
    pub action_player: Option<Seat>,
    pub decision: Decision,
    pub source: CardId,
    // Internal entry-registration boundary; zero in every returned position.
    pub disabled_ongoing_source: CardId,
    pub target: CardId,
    pub ambush: bool,
    pub after_attack_triggers: u8,
    pub attack_restore: u16,
    pub attack_source: CardId,
    pub attack_defender: CardId,
    pub attack_shield_opponent_first: bool,
    pub pending_triggers: u8,
    pub trigger_context: u8,
    pub pending_programs: u16,
    pub after_attack_programs: u16,
    /// Zero means no IR continuation; otherwise program index plus one.
    pub ability_program: u16,
    pub ability_pc: u8,
    pub ability_target: CardId,
    pub ability_selection: Selection,
    pub event_group: EventGroupState,
    pub ability_result: u16,
    pub ability_succeeded: bool,
    pub ability_return: u8,
    pub ability_committed: bool,
    pub resource_done: [bool; 2],
    pub resource_selected: [CardId; 2],
    /// 0 ongoing, 1 p1, 2 p2, 3 draw.
    pub outcome: u8,
}
impl Default for State {
    fn default() -> Self {
        Self {
            death_pending:DeathWindow::default(), death_window:DeathWindow::default(),
            death_frames:[DeathFrame::default();MAX_DEATH_DEPTH], death_depth:0,
            cards: [Card::default(); MAX_CARDS],
            next_id: 1,
            players: [Player::default(); 2],
            arena_unit_order:[ArenaOrder::default();2],arena_order_exact:true,hidden_history_exact:false,force_state_exact:false,
            round: 1,
            regroup: false,
            initiative: Seat::P1,
            initiative_claimed: false,
            prev_passed: false,
            active: Seat::P1,
            action_player:Some(Seat::P1),
            decision: Decision::Window,
            source: 0,
            disabled_ongoing_source: 0,
            target: 0,
            ambush: false,
            after_attack_triggers: 0,
            attack_restore: 0,
            attack_source: 0,attack_defender:0,
            attack_shield_opponent_first: false,
            pending_triggers: 0,
            trigger_context: 0,
            pending_programs: 0,
            after_attack_programs: 0,
            ability_program: 0,
            ability_pc: 0,
            ability_target: 0,
            ability_selection: Selection::default(),
            event_group: EventGroupState::default(),
            ability_result: 0,
            ability_succeeded: false,
            ability_return: 0,
            ability_committed: false,
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
        fn context_values(c:&ResolutionContext,put:&mut impl FnMut(u64)) {
            for v in [c.active.index() as u64,c.decision as u64,c.source as u64,c.target as u64,c.ambush as u64,c.after_attack_triggers as u64,c.attack_restore as u64,c.attack_source as u64,c.attack_defender as u64,c.attack_shield_opponent_first as u64,c.pending_triggers as u64,c.trigger_context as u64,c.pending_programs as u64,c.after_attack_programs as u64,c.ability_program as u64,c.ability_pc as u64,c.ability_target as u64,c.ability_result as u64,c.ability_succeeded as u64,c.ability_return as u64,c.ability_committed as u64,c.ability_selection.len as u64] {put(v);}
            for id in c.ability_selection.ids {put(id as u64);}
        }
        fn window_values(w:&DeathWindow,put:&mut impl FnMut(u64)) {
            for v in [w.len as u64,w.initiator.index() as u64,w.player.index() as u64,w.player_chosen as u64,w.group_program as u64,w.group_source as u64,w.group_keyword as u64,w.resolve_all as u64] {put(v);}
            for e in w.entries {for v in [e.source as u64,e.program as u64,e.player.index() as u64,e.after_pc as u64,e.defer_depth as u64,e.keyword as u64] {put(v);}}
        }
        put(self.death_depth as u64);
        window_values(&self.death_pending,&mut put);window_values(&self.death_window,&mut put);
        for f in &self.death_frames {put(f.resume as u64);context_values(&f.context,&mut put);window_values(&f.window,&mut put);}
        put(self.next_id as u64);
        put(self.arena_order_exact as u64);
        for arena in self.arena_unit_order {put(arena.len as u64);for id in arena.ids {put(id as u64);}}
        put(self.round as u64);
        if self.hidden_history_exact {put(1); }
        if self.force_state_exact {put(1);}
        put(self.regroup as u64);
        put(self.initiative.index() as u64);
        put(self.initiative_claimed as u64);
        put(self.prev_passed as u64);
        put(self.active.index() as u64);
        put(self.action_player.map_or(0,|p|p.index() as u64+1));
        put(self.decision as u64);
        put(self.source as u64);
        put(self.target as u64);
        put(self.ambush as u64);
        put(self.after_attack_triggers as u64);
        put(self.attack_restore as u64);
        put(self.attack_source as u64);put(self.attack_defender as u64);
        put(self.attack_shield_opponent_first as u64);
        put(self.pending_triggers as u64);
        put(self.disabled_ongoing_source as u64);
        put(self.trigger_context as u64);
        put(self.outcome as u64);
        put(self.pending_programs as u64);
        put(self.after_attack_programs as u64);
        put(self.ability_program as u64);
        put(self.ability_pc as u64);
        put(self.ability_target as u64);
        put(self.ability_selection.len as u64);
        for id in self.ability_selection.ids { put(id as u64); }
        let g = &self.event_group;
        put(g.discard_count as u64);put(g.discard_owner.index() as u64);
        put(g.active as u64); put(g.resolving as u64); put(g.replacement_done as u64); put(g.shield_mask as u64); put(g.shield_count as u64); put(g.shield_priority as u64); put(g.shield_stash_len as u64); for id in g.shield_stash { put(id as u64); } put(g.initiator.index() as u64); put(g.pc as u64); put(g.count as u64); put(g.depth as u64);
        for selection in [g.context, g.picks].into_iter().chain(g.stack) {
            put(selection.len as u64); for id in selection.ids { put(id as u64); }
        }
        for event in g.records { put(event.op as u64); put(event.target as u64); put(event.amount as u64);
            put(event.power as u64); put(event.hp as u64); put(event.token as u64);  }

        // Inactive default storage preserves the historical hash stream.
        let uniform=&g.uniform_damage;
        if uniform.active {
            put(uniform.active as u64);put(uniform.count as u64);
            for mask in uniform.prevented {put(mask);}
            for record in uniform.records {put(record.target as u64);put(record.shield as u64);}
        } else {debug_assert_eq!(*uniform,UniformDamageState::default(),"inactive uniform storage must be cleared");}

        put(self.ability_result as u64);
        put(self.ability_succeeded as u64);
        put(self.ability_return as u64);
        put(self.ability_committed as u64);
        for n in 0..2 {
            put(self.resource_done[n] as u64);
            put(self.resource_selected[n] as u64);
        }
        // Qualification is observable only for current arena members. Build
        // membership once rather than scanning every zone for every card.
        let mut hidden_arena_members=[false;MAX_CARDS];
        if self.hidden_history_exact {
            for player in &self.players {for arena in [&player.ground,&player.space] {
                for &id in arena.as_slice() {hidden_arena_members[id as usize]=true;}
            }}
        }
        for (idx, c) in self
            .cards
            .iter()
            .enumerate()
            .take(self.next_id as usize)
            .skip(1)
        {
            put(idx as u64);
            put(c.experience as u64);
            put(c.phase_power as u64);
            put(c.phase_hp as u64);
            for amount in c.phase_keyword_values { put(amount as u64); }
            put(c.phase_lost_keywords as u64);
            put(c.phase_keyword_presence as u64);
            if self.hidden_history_exact {
                let in_arena=hidden_arena_members[idx];
                // Identity history outside the arena is inert in the admitted no-reentry domain.
                put((c.hidden_state & if in_arena {u8::MAX}else{!1}) as u64);
            }
            put(c.next_token as u64);
            put(c.parent as u64);put(c.upgrades as u64);put(c.next_upgrade as u64);
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
            if self.force_state_exact {put(p.force_id as u64);put(p.force_held as u64);}
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

impl Card {
    pub fn hidden_qualified(&self)->bool {self.hidden_state & 1 != 0}
    pub fn set_hidden_qualified(&mut self,value:bool) {self.hidden_state=(self.hidden_state & !1)|u8::from(value);}
    pub fn phase_keyword_mask(&self)->u16 {self.phase_keyword_presence as u16 | if self.hidden_state&2!=0 {1<<8}else{0}}
    pub fn lost_keyword_mask(&self)->u16 {self.phase_lost_keywords as u16 | if self.hidden_state&4!=0 {1<<8}else{0}}
    pub fn add_phase_keyword(&mut self,index:usize) {if index==8 {self.hidden_state|=2;}else{self.phase_keyword_presence|=1<<index;}}
    pub fn add_lost_keyword(&mut self,index:usize) {if index==8 {self.hidden_state|=4;}else{self.phase_lost_keywords|=1<<index;}}
    pub fn clear_hidden_phase_effects(&mut self) {self.hidden_state &= 1;}
    pub fn phase_keyword_amount(&self, index: usize) -> u16 {
        if let Some(slot) = crate::ability_ir::numeric_keyword_slot(index) { self.phase_keyword_values[slot] } else { u16::from(self.phase_keyword_mask() & (1 << index) != 0) }
    }
}
