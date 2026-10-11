#[path = "generic_runtime.rs"]
mod generic_runtime;
use crate::ability_ir::{CardPrograms, Catalogue};
use crate::model::*;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, path::Path};
use swu_bot_rs::cards::{CardDb, CardInfo};

const SENTINEL: u16 = 1;
const OVERWHELM: u16 = 2;
const SABOTEUR: u16 = 4;
const AMBUSH: u16 = 8;
const GRIT: u16 = 16;
const SHIELDED: u16 = 32;
const T_RESTORE: u8 = 1;
const T_SABOTEUR: u8 = 2;
const T_LEADER: u8 = 4;
const T_SHIELD: u8 = 8;
const T_AMBUSH: u8 = 16;
#[derive(Debug, Clone)]
pub struct Definition {
    pub code: String,
    pub info: CardInfo,
    flags: u16,
    raid: u16,
    restore: u16,
    aspects: [u8; 6],
    programs: CardPrograms,
    traits: Vec<String>,
}
pub struct Engine {
    pool_hash: String,
    pub definitions: Vec<Definition>,
    by_code: HashMap<String, u16>,
    shield_def: u16,
    experience_def: Option<u16>,
    catalogue: Option<Catalogue>,
}
fn aspect(s: &str) -> Result<usize, String> {
    match s {
        "vigilance" => Ok(0),
        "command" => Ok(1),
        "aggression" => Ok(2),
        "cunning" => Ok(3),
        "heroism" => Ok(4),
        "villainy" => Ok(5),
        _ => Err(format!("unsupported aspect {s}")),
    }
}
fn cid(s: &str) -> Result<CardId, String> {
    s.strip_prefix('c')
        .and_then(|s| s.parse::<u16>().ok())
        .and_then(|n| n.checked_add(1))
        .filter(|&n| (n as usize) < MAX_CARDS)
        .ok_or_else(|| format!("unsupported card identity {s}"))
}
fn b(v: &Value, k: &str) -> bool {
    v[k].as_bool().unwrap_or(false)
}
fn n(v: &Value, k: &str) -> u16 {
    v[k].as_u64().unwrap_or(0) as u16
}
fn keyword_text(text: &str) -> Result<(u16, u16, u16), String> {
    let mut plain = String::new();
    let mut nesting = 0;
    for c in text.chars() {
        if c == '(' {
            nesting += 1;
        } else if c == ')' {
            nesting -= 1;
        } else if nesting == 0 {
            plain.push(c);
        }
    }
    let mut flags = 0;
    let mut raid = 0;
    let mut restore = 0;
    for line in plain.lines().map(str::trim).filter(|s| !s.is_empty()) {
        let words: Vec<_> = line.split_whitespace().collect();
        let kw = words[0].to_ascii_lowercase();
        match kw.as_str() {
            "sentinel" => flags |= SENTINEL,
            "overwhelm" => flags |= OVERWHELM,
            "saboteur" => flags |= SABOTEUR,
            "ambush" => flags |= AMBUSH,
            "grit" => flags |= GRIT,
            "shielded" => flags |= SHIELDED,
            "raid" | "restore" => {
                let amount = words
                    .get(1)
                    .and_then(|s| s.parse::<u16>().ok())
                    .ok_or_else(|| format!("invalid keyword {line}"))?;
                if kw == "raid" {
                    raid += amount;
                } else {
                    restore += amount;
                }
            }
            _ => return Err(format!("unsupported ability text {line:?}")),
        }
        if words.len()
            != if kw == "raid" || kw == "restore" {
                2
            } else {
                1
            }
        {
            return Err(format!("unsupported ability text {line:?}"));
        }
    }
    Ok((flags, raid, restore))
}
impl Engine {
    pub fn from_pool(path: &Path) -> Result<Self, String> {
        let bytes = std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
        Self::from_pool_bytes(&bytes)
    }
    /// Browser and native hosts share exactly the same catalogue validation and
    /// provenance hash; this constructor does not access the filesystem.
    pub fn from_pool_bytes(bytes: &[u8]) -> Result<Self, String> {
        let v: Value = serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
        let mut e = Self::from_pool_value(&v)?;
        e.pool_hash = format!("{:x}", Sha256::digest(bytes));
        Ok(e)
    }
    pub fn from_pool_value(v: &Value) -> Result<Self, String> {
        crate::validation::validate_pool(v)?;
        let cards = v["cards"].as_array().ok_or("pool needs cards array")?;
        let mut shared = CardDb::default();
        let mut definitions = Vec::new();
        let mut by_code = HashMap::new();
        let mut shield_def = None;
        for raw in cards {
            let info: CardInfo = serde_json::from_value(raw.clone()).map_err(|e| e.to_string())?;
            shared.insert(info.clone());
            let code = raw["setCode"]
                .as_str()
                .ok_or("pool card missing setCode")?
                .to_owned();
            let fail = |why: String| format!("unsupported card {} ({code}): {why}", info.title);
            let (flags, raid, restore) = if info.is("leader") {
                match code.as_str() {
                    "SOR_014" | "IBH_053" => (0, 0, 0),
                    "SEC_005" => (0, 0, 4),
                    _ => return Err(fail("leader implementation absent".into())),
                }
            } else if info.is("base") {
                if info.hp != Some(30)
                    || !info.text.as_deref().unwrap_or("").trim().is_empty()
                    || !info.epic_action.as_deref().unwrap_or("").trim().is_empty()
                {
                    return Err(fail("only plain 30 HP bases are supported".into()));
                }
                (0, 0, 0)
            } else if code == "TOKEN_SHIELD" && info.internal_name == "shield" {
                (0, 0, 0)
            } else if info.is("unit") {
                keyword_text(info.text.as_deref().unwrap_or("")).map_err(fail)?
            } else {
                return Err(fail("only keyword-only units, explicit leaders, plain bases and Shield are supported".into()));
            };
            let mut aspects = [0; 6];
            for a in info.aspects() {
                aspects[aspect(a)?] += 1;
            }
            if info.is("unit") || info.is("leader") {
                if !matches!(info.arena.as_deref(), Some("ground" | "space")) {
                    return Err(fail("missing arena".into()));
                }
            }
            let index = definitions.len() as u16;
            if by_code.insert(code.clone(), index).is_some() {
                return Err(format!("duplicate pool code {code}"));
            }
            if code == "TOKEN_SHIELD" {
                shield_def = Some(index);
            }
            definitions.push(Definition {
                code,
                info,
                flags,
                raid,
                restore,
                aspects,
                programs: CardPrograms::default(),
                traits: vec![],
            });
        }
        // The shared loader owns catalogue interpretation; this also exercises its identity indexing.
        for d in &definitions {
            if shared.by_name(&d.info.internal_name).is_none() {
                return Err(format!("card loader rejected {}", d.code));
            }
        }
        Ok(Self {
            pool_hash: String::new(),
            definitions,
            by_code,
            shield_def: shield_def.ok_or("pool must include TOKEN_SHIELD")?,
            experience_def: None,
            catalogue: None,
        })
    }
    pub fn pool_hash(&self) -> &str {
        &self.pool_hash
    }
    fn def<'a>(&'a self, s: &State, id: CardId) -> &'a Definition {
        &self.definitions[s.card(id).def as usize]
    }
    fn in_arena(&self, s: &State, id: CardId) -> bool {
        let p = s.player(s.card(id).owner);
        p.ground.contains(id) || p.space.contains(id)
    }
    fn card_action(&self, s: &State, id: CardId) -> Action {
        Action::card(id, &self.def(s, id).info.internal_name)
    }
    fn ready_resources(&self, s: &State, p: Seat) -> usize {
        s.player(p)
            .resources
            .as_slice()
            .iter()
            .filter(|&&id| !s.card(id).exhausted)
            .count()
    }
    pub fn cost(&self, s: &State, id: CardId) -> u16 {
        let p = s.player(s.card(id).owner);
        let d = self.def(s, id);
        let leader = self.def(s, p.leader);
        let base = self.def(s, p.base);
        let penalty: u16 = (0..6)
            .map(|i| {
                u16::from(d.aspects[i].saturating_sub(leader.aspects[i] + base.aspects[i])) * 2
            })
            .sum();
        d.info.cost().max(0) as u16 + penalty
    }
    pub fn power(&self, s: &State, id: CardId, attacking: bool) -> u16 {
        let d = self.def(s, id);
        d.info.power.unwrap_or(0).max(0) as u16
            + if d.flags & GRIT != 0 {
                s.card(id).damage
            } else {
                0
            }
            + if attacking { d.raid } else { 0 }
            + self.token_count(s, s.card(id).experience)
    }
    fn leader_available(&self, s: &State) -> (bool, bool) {
        if self.catalogue.is_some() {
            let id = s.player(s.active).leader;
            let c = s.card(id);
            let deploy = !c.deployed
                && !c.epic_used
                && s.player(s.active).resources.len as i32 >= self.def(s, id).info.cost();
            return (
                deploy,
                !c.deployed && !self.available_programs(s, id, "action").is_empty(),
            );
        }
        let p = s.player(s.active);
        let c = s.card(p.leader);
        let d = self.def(s, p.leader);
        let deploy = !c.deployed && !c.epic_used && p.resources.len as i32 >= d.info.cost();
        let ability = !c.deployed
            && !c.exhausted
            && match d.code.as_str() {
                "IBH_053" => self.ready_resources(s, s.active) > 0,
                "SEC_005" => true,
                _ => true,
            };
        (deploy, ability)
    }
    fn leader_title(&self, s: &State) -> &'static str {
        match self.def(s, s.player(s.active).leader).code.as_str() {
            "SOR_014" => "Deal 1 damage to each base",
            "IBH_053" => "Deal 1 damage to a base",
            _ => "Heal up to 2 damage from a unit. If you do, deal that much damage to your base",
        }
    }
    fn attack_targets(&self, s: &State, source: CardId, ambush: bool) -> Vec<CardId> {
        let d = self.def(s, source);
        let opp = s.player(s.card(source).owner.other());
        let zone = if d.info.arena.as_deref() == Some("space") {
            &opp.space
        } else {
            &opp.ground
        };
        let sentinel = d.flags & SABOTEUR == 0
            && zone
                .as_slice()
                .iter()
                .any(|&c| self.def(s, c).flags & SENTINEL != 0);
        let mut out: Vec<_> = zone
            .as_slice()
            .iter()
            .copied()
            .filter(|&c| !sentinel || self.def(s, c).flags & SENTINEL != 0)
            .collect();
        if !ambush && !sentinel {
            out.push(opp.base);
        }
        out
    }
    pub fn legal_actions(&self, s: &State) -> Vec<Action> {
        if s.is_terminal() {
            return vec![];
        }
        if self.is_ability_decision(s.decision) {
            return self.ability_actions(s);
        }
        let p = s.player(s.active);
        let mut out = Vec::new();
        match s.decision {
            Decision::Window => {
                out.push(Action::button("Pass", "pass"));
                if !s.initiative_claimed {
                    out.push(Action::button("Claim Initiative", "claimInitiative"));
                }
                for &id in p.ground.as_slice().iter().chain(p.space.as_slice()) {
                    if !s.card(id).exhausted || !self.available_programs(s, id, "action").is_empty()
                    {
                        out.push(self.card_action(s, id));
                    }
                }
                for &id in p.hand.as_slice() {
                    if self.catalogue.is_some()
                        && self.def(s, id).info.is("event")
                        && self.available_programs(s, id, "event").is_empty()
                    {
                        continue;
                    }
                    if self.cost(s, id) as usize <= self.ready_resources(s, s.active) {
                        out.push(self.card_action(s, id));
                    }
                }
                let (deploy, ability) = self.leader_available(s);
                if deploy || ability {
                    out.push(self.card_action(s, p.leader));
                }
            }
            Decision::LeaderMenu => {
                let (deploy, ability) = self.leader_available(s);
                if deploy {
                    out.push(Action::button(
                        format!("Deploy {}", self.def(s, p.leader).info.title),
                        out.len(),
                    ));
                }
                if ability && self.catalogue.is_some() {
                    for program in self.available_programs(s, p.leader, "action") {
                        out.push(Action::button(
                            self.program_menu_title(s, p.leader, program),
                            out.len(),
                        ));
                    }
                } else if ability {
                    let title = self.leader_title(s);
                    let title = if self.def(s, p.leader).code == "SEC_005"
                        && s.players.iter().all(|p| p.ground.len + p.space.len == 0)
                    {
                        format!("(No effect) {title}")
                    } else {
                        title.to_string()
                    };
                    out.push(Action::button(title, out.len()));
                }
                out.push(Action::button("Cancel", out.len()));
            }
            Decision::AttackTarget => {
                if !s.ambush {
                    out.push(Action::button("Cancel", "cancel"));
                }
                for id in self.attack_targets(s, s.source, s.ambush) {
                    out.push(self.card_action(s, id));
                }
            }
            Decision::VaderBase => {
                if s.trigger_context == 0 {
                    out.push(Action::button("Cancel", "cancel"));
                }
                for p in &s.players {
                    out.push(self.card_action(s, p.base));
                }
            }
            Decision::NoEffect => {
                out.push(Action::button("Use it anyway", 0));
                out.push(Action::button("Cancel", 1));
            }
            Decision::SatineHeal => {
                out.push(Action {
                    kind: "distribute".into(),
                    card: None,
                    arg: Some(json!([])),
                    method: None,
                    label: "distribute 2".into(),
                });
                for p in &s.players {
                    for &id in p.ground.as_slice().iter().chain(p.space.as_slice()) {
                        for amount in 1..=2 {
                            out.push(Action {
                                kind: "distribute".into(),
                                card: None,
                                arg: Some(json!([[format!("c{}", id - 1), amount]])),
                                method: None,
                                label: "distribute 2".into(),
                            });
                        }
                    }
                }
            }
            Decision::Resource => {
                let sel = s.resource_selected[s.active.index()];
                out.push(Action::button(
                    if sel == 0 {
                        "Skip Resourcing"
                    } else {
                        "Confirm Resources"
                    },
                    "done",
                ));
                for &id in p.hand.as_slice() {
                    if id != sel {
                        out.push(self.card_action(s, id));
                    }
                }
            }
            Decision::Unique => {
                for &id in p.ground.as_slice().iter().chain(p.space.as_slice()) {
                    if s.card(id).def == s.card(s.source).def {
                        out.push(self.card_action(s, id));
                    }
                }
            }
            Decision::Ambush => {
                out.push(Action::button("Trigger", "trigger"));
                out.push(Action::button("Pass", "pass"));
            }
            Decision::TriggerOrder => {
                for label in self.ordered_trigger_titles(s) {
                    out.push(Action::button(label, out.len().to_string()));
                }
            }
            Decision::ShieldOrder => {
                out.push(Action::button("You", 0));
                out.push(Action::button("Opponent", 1));
            }
            Decision::AbilityMenu
            | Decision::AbilityTarget
            | Decision::AbilityOptional
            | Decision::AbilityNoEffect
            | Decision::AbilityDistribute => unreachable!(),
            Decision::Terminal => {}
        }
        out
    }
    fn trigger_bits(&self, s: &State) -> Vec<u8> {
        let mut bits: Vec<_> = [T_RESTORE, T_SABOTEUR, T_LEADER, T_AMBUSH, T_SHIELD]
            .into_iter()
            .filter(|bit| s.pending_triggers & bit != 0)
            .collect();
        bits.sort_by_key(|&bit| !self.trigger_effect(s, bit));
        bits
    }
    fn trigger_title(&self, s: &State, bit: u8) -> String {
        match bit {
            T_RESTORE => format!("Restore {}", self.def(s, s.source).restore),
            T_SABOTEUR => "Saboteur: defeat all shields".into(),
            T_LEADER => {
                if self.def(s, s.source).code == "IBH_053" {
                    "Deal 2 damage to a base".into()
                } else {
                    "Deal 1 damage to each enemy base".into()
                }
            }
            T_SHIELD => "Shielded".into(),
            _ => "Ambush".into(),
        }
    }
    fn trigger_effect(&self, s: &State, bit: u8) -> bool {
        match bit {
            T_RESTORE => s.card(s.player(s.active).base).damage > 0,
            T_SABOTEUR => s.card(s.target).shield != 0,
            T_AMBUSH => !self.attack_targets(s, s.source, true).is_empty(),
            _ => true,
        }
    }
    pub fn set_actor(&self, s: &mut State, actor: Seat) -> Result<(), String> {
        if s.decision == Decision::Resource && !s.resource_done[actor.index()] {
            s.active = actor;
            Ok(())
        } else if s.actor() == Some(actor) {
            Ok(())
        } else {
            Err(format!(
                "actor mismatch: Rust {:?}, trace {actor:?}",
                s.actor()
            ))
        }
    }
    pub fn order_regroup(&self, s: &mut State, prover: Seat) {
        if s.decision == Decision::Resource
            && s.resource_done == [false; 2]
            && s.resource_selected == [0; 2]
        {
            s.active = prover;
        }
    }
    pub fn apply(&self, s: &State, a: &Action) -> Result<State, String> {
        if !self.legal_actions(s).contains(a) {
            return Err(format!("illegal action {} at {:?}", a.key(), s.decision));
        }
        if self.is_ability_decision(s.decision) {
            return self.apply_ability_action(s, a);
        }
        let mut t = *s;
        let seat = t.active;
        let id = a.id().unwrap_or(0);
        let arg = a.arg.as_ref().and_then(Value::as_str).unwrap_or("");
        match t.decision {
            Decision::Window => {
                if arg == "pass" || arg == "claimInitiative" {
                    if arg == "claimInitiative" {
                        t.initiative = seat;
                        t.initiative_claimed = true;
                        t.player_mut(seat).out = true;
                    }
                    if t.prev_passed {
                        t.players[0].out = true;
                        t.players[1].out = true;
                    } else if t.player(seat.other()).out {
                        t.player_mut(seat).out = true;
                    } else {
                        t.prev_passed = true;
                    }
                    self.advance(&mut t)?;
                } else if id == t.player(seat).leader && !t.card(id).deployed {
                    t.source = id;
                    let (deploy, ability) = self.leader_available(&t);
                    if deploy || self.available_programs(&t, id, "action").len() > 1 {
                        t.decision = Decision::LeaderMenu;
                    } else if ability {
                        self.use_leader(&mut t)?;
                    }
                } else if t.player(seat).hand.contains(id) {
                    if self.catalogue.is_some() && self.def(&t, id).info.is("event") {
                        t.source = id;
                        t.trigger_context = 0;
                        let programs = self.available_programs(&t, id, "event");
                        let program = *programs.first().ok_or("event has no executable ability")?;
                        self.begin_program(&mut t, program, 0)?;
                        return Ok(t);
                    }
                    self.spend(&mut t, self.cost(s, id));
                    t.player_mut(seat).hand.remove(id);
                    t.card_mut(id).exhausted = true;
                    self.add_arena(&mut t, id)?;
                    t.source = id;
                    t.trigger_context = 1;
                    if self.def(&t, id).info.unique && self.duplicates(&t, id) > 1 {
                        t.decision = Decision::Unique;
                    } else {
                        self.enter_triggers(&mut t)?;
                    }
                } else {
                    t.source = id;
                    t.ambush = false;
                    t.trigger_context = 0;
                    let programs = self.available_programs(&t, id, "action");
                    if t.card(id).exhausted && programs.len() == 1 {
                        self.begin_program(&mut t, programs[0], 0)?;
                    } else {
                        t.decision = if programs.is_empty() {
                            Decision::AttackTarget
                        } else {
                            Decision::AbilityMenu
                        };
                    }
                }
            }
            Decision::LeaderMenu => {
                if a.label == "Cancel" {
                    self.cancel(&mut t);
                } else if a.label.starts_with("Deploy ") {
                    let leader = t.player(seat).leader;
                    {
                        let c = t.card_mut(leader);
                        c.deployed = true;
                        c.epic_used = true;
                        c.exhausted = false;
                    }
                    self.add_arena(&mut t, leader)?;
                    self.finish(&mut t)?;
                } else {
                    if self.catalogue.is_some() {
                        let id = t.player(seat).leader;
                        let (deploy, _) = self.leader_available(&t);
                        let index = a
                            .arg
                            .as_ref()
                            .and_then(Value::as_u64)
                            .ok_or("ability index missing")?
                            as usize
                            - usize::from(deploy);
                        let program = self.available_programs(&t, id, "action")[index];
                        self.begin_program(&mut t, program, 0)?;
                    } else {
                        self.use_leader(&mut t)?;
                    }
                }
            }
            Decision::AttackTarget => {
                if arg == "cancel" {
                    self.cancel(&mut t);
                } else {
                    t.target = id;
                    let source = t.source;
                    t.card_mut(source).exhausted = true;
                    t.trigger_context = 2;
                    t.pending_triggers = 0;
                    let d = self.def(&t, source);
                    if d.restore > 0 {
                        t.pending_triggers |= T_RESTORE;
                    }
                    if d.flags & SABOTEUR != 0 && self.in_arena(&t, id) {
                        t.pending_triggers |= T_SABOTEUR;
                    }
                    if self.catalogue.is_none() && (d.code == "SOR_014" || d.code == "IBH_053") {
                        t.pending_triggers |= T_LEADER;
                    }
                    self.queue_programs(&mut t, "onAttack");
                    self.process_triggers(&mut t)?;
                }
            }
            Decision::VaderBase => {
                if arg == "cancel" {
                    self.cancel(&mut t);
                } else {
                    if t.trigger_context == 0 {
                        self.spend(&mut t, 1);
                        let leader = t.player(seat).leader;
                        t.card_mut(leader).exhausted = true;
                    }
                    let amount = if t.trigger_context == 0 { 1 } else { 2 };
                    t.card_mut(id).damage += amount;
                    self.check_win(&mut t);
                    if t.trigger_context == 0 {
                        self.finish(&mut t)?;
                    } else {
                        self.process_triggers(&mut t)?;
                    }
                }
            }
            Decision::NoEffect => {
                if a.label == "Cancel" {
                    self.cancel(&mut t);
                } else {
                    let leader = t.player(seat).leader;
                    t.card_mut(leader).exhausted = true;
                    self.finish(&mut t)?;
                }
            }
            Decision::SatineHeal => {
                let leader = t.player(seat).leader;
                t.card_mut(leader).exhausted = true;
                if let Some(pair) = a
                    .arg
                    .as_ref()
                    .and_then(Value::as_array)
                    .and_then(|v| v.first())
                {
                    let target = cid(pair[0].as_str().ok_or("missing healing card")?)?;
                    let heal = (pair[1].as_u64().ok_or("missing healing amount")? as u16)
                        .min(t.card(target).damage);
                    t.card_mut(target).damage -= heal;
                    let base = t.player(seat).base;
                    t.card_mut(base).damage += heal;
                }
                self.check_win(&mut t);
                self.finish(&mut t)?;
            }
            Decision::Resource => {
                if id != 0 {
                    if t.resource_selected[seat.index()] == 0 {
                        t.resource_selected[seat.index()] = id;
                    }
                } else {
                    t.resource_done[seat.index()] = true;
                    if t.resource_done == [true; 2] {
                        self.end_regroup(&mut t)?;
                    } else {
                        t.active = seat.other();
                    }
                }
            }
            Decision::Unique => {
                self.defeat(&mut t, id)?;
                self.enter_triggers(&mut t)?;
            }
            Decision::Ambush => {
                if arg == "trigger" && !self.attack_targets(&t, t.source, true).is_empty() {
                    t.after_attack_programs = t.pending_programs;
                    t.pending_programs = 0;
                    t.after_attack_triggers = t.pending_triggers;
                    t.pending_triggers = 0;
                    t.ambush = true;
                    t.decision = Decision::AttackTarget;
                } else {
                    self.process_triggers(&mut t)?;
                }
            }
            Decision::TriggerOrder => {
                let index = arg.parse::<usize>().map_err(|e| e.to_string())?;
                self.resolve_ordered_trigger(&mut t, index)?;
            }
            Decision::ShieldOrder => {
                t.trigger_context = 3;
                self.combat(&mut t)?;
            }
            Decision::AbilityMenu
            | Decision::AbilityTarget
            | Decision::AbilityOptional
            | Decision::AbilityNoEffect
            | Decision::AbilityDistribute => unreachable!(),
            Decision::Terminal => return Err("game is over".into()),
        }
        Ok(t)
    }
    fn duplicates(&self, s: &State, id: CardId) -> usize {
        let p = s.player(s.card(id).owner);
        p.ground
            .as_slice()
            .iter()
            .chain(p.space.as_slice())
            .filter(|&&c| s.card(c).def == s.card(id).def)
            .count()
    }
    fn spend(&self, s: &mut State, mut amount: u16) {
        let ids = s.player(s.active).resources;
        for &id in ids.as_slice() {
            if amount > 0 && !s.card(id).exhausted {
                s.card_mut(id).exhausted = true;
                amount -= 1;
            }
        }
        debug_assert_eq!(amount, 0);
    }
    fn add_arena(&self, s: &mut State, id: CardId) -> Result<(), String> {
        let space = self.def(s, id).info.arena.as_deref() == Some("space");
        let p = s.player_mut(s.card(id).owner);
        if space {
            p.space.push(id)
        } else {
            p.ground.push(id)
        }
    }
    fn use_leader(&self, s: &mut State) -> Result<(), String> {
        if self.catalogue.is_some() {
            let id = s.player(s.active).leader;
            s.source = id;
            s.trigger_context = 0;
            let program = *self
                .available_programs(s, id, "action")
                .first()
                .ok_or("leader has no executable action")?;
            return self.begin_program(s, program, 0);
        }
        let id = s.player(s.active).leader;
        s.source = id;
        s.trigger_context = 0;
        match self.def(s, id).code.as_str() {
            "SOR_014" => {
                s.card_mut(id).exhausted = true;
                for seat in [Seat::P1, Seat::P2] {
                    let base = s.player(seat).base;
                    s.card_mut(base).damage += 1;
                }
                self.check_win(s);
                self.finish(s)?;
            }
            "IBH_053" => s.decision = Decision::VaderBase,
            _ => {
                s.decision = if s.players.iter().all(|p| p.ground.len + p.space.len == 0) {
                    Decision::NoEffect
                } else {
                    Decision::SatineHeal
                }
            }
        }
        Ok(())
    }
    fn cancel(&self, s: &mut State) {
        s.source = 0;
        s.target = 0;
        s.trigger_context = 0;
        s.pending_triggers = 0;
        s.ambush = false;
        s.ability_program = 0;
        s.ability_pc = 0;
        s.ability_target = 0;
        s.ability_result = 0;
        s.ability_succeeded = false;
        s.ability_return = 0;
        s.ability_committed = false;
        s.pending_programs = 0;
        s.after_attack_programs = 0;
        s.decision = Decision::Window;
    }
    fn enter_triggers(&self, s: &mut State) -> Result<(), String> {
        if !self.in_arena(s, s.source) {
            return self.finish(s);
        }
        let flags = self.def(s, s.source).flags;
        s.pending_triggers = if flags & SHIELDED != 0 { T_SHIELD } else { 0 }
            | if flags & AMBUSH != 0 && !self.attack_targets(s, s.source, true).is_empty() {
                T_AMBUSH
            } else {
                0
            };
        s.trigger_context = 1;
        self.queue_programs(s, "whenPlayed");
        self.process_triggers(s)
    }
    fn process_triggers(&self, s: &mut State) -> Result<(), String> {
        if self.catalogue.is_some() {
            return self.process_all_triggers(s);
        }
        if s.is_terminal() && s.trigger_context != 2 {
            return Ok(());
        }
        if s.pending_triggers.count_ones() > 1
            && ![T_RESTORE, T_SABOTEUR, T_LEADER, T_AMBUSH, T_SHIELD]
                .iter()
                .any(|&bit| s.pending_triggers & bit != 0 && self.trigger_effect(s, bit))
        {
            s.pending_triggers = 0;
        }
        if s.pending_triggers.count_ones() > 1 {
            s.decision = Decision::TriggerOrder;
            return Ok(());
        }
        if s.pending_triggers != 0 {
            let bit = s.pending_triggers;
            return self.resolve_trigger(s, bit);
        }
        if s.trigger_context == 2 {
            self.combat(s)
        } else {
            self.finish(s)
        }
    }
    fn resolve_trigger(&self, s: &mut State, bit: u8) -> Result<(), String> {
        s.pending_triggers &= !bit;
        match bit {
            T_RESTORE => {
                let base = s.player(s.active).base;
                s.card_mut(base).damage = s
                    .card(base)
                    .damage
                    .saturating_sub(self.def(s, s.source).restore);
            }
            T_SABOTEUR => s.card_mut(s.target).shield = 0,
            T_LEADER => {
                if self.def(s, s.source).code == "IBH_053" {
                    s.decision = Decision::VaderBase;
                    return Ok(());
                }
                let base = s.player(s.active.other()).base;
                s.card_mut(base).damage += 1;
                self.check_win(s);
            }
            T_SHIELD => {
                if s.next_id as usize >= MAX_CARDS {
                    return Err("card capacity exceeded while creating Shield".into());
                }
                let id = s.next_id;
                s.next_id += 1;
                *s.card_mut(id) = Card {
                    present: true,
                    def: self.shield_def,
                    owner: s.active,
                    ..Card::default()
                };
                s.card_mut(s.source).shield = id;
            }
            T_AMBUSH => {
                s.decision = Decision::Ambush;
                return Ok(());
            }
            _ => return Err("unknown trigger".into()),
        }
        self.process_triggers(s)
    }
    fn damage(&self, s: &mut State, id: CardId, amount: u16) {
        if amount == 0 {
            return;
        }
        if s.card(id).shield != 0 {
            let mut token = s.card(id).shield;
            let mut previous = 0;
            while s.card(token).next_token != 0 {
                previous = token;
                token = s.card(token).next_token;
            }
            if previous == 0 {
                s.card_mut(id).shield = 0;
            } else {
                s.card_mut(previous).next_token = 0;
            }
        } else {
            s.card_mut(id).damage = s.card(id).damage.saturating_add(amount);
        }
    }
    fn combat(&self, s: &mut State) -> Result<(), String> {
        let source = s.source;
        let target = s.target;
        if s.trigger_context != 3
            && s.card(source).shield != 0
            && s.card(target).shield != 0
            && self.power(s, source, true) > 0
            && self.power(s, target, false) > 0
        {
            s.decision = Decision::ShieldOrder;
            return Ok(());
        }
        let attack = self.power(s, source, true);
        let target_unit = self.in_arena(s, target);
        if target_unit {
            let defend = self.power(s, target, false);
            let remaining = self.hp(s, target).saturating_sub(s.card(target).damage);
            let excess = if self.def(s, source).flags & OVERWHELM != 0 {
                attack.saturating_sub(remaining)
            } else {
                0
            };
            self.damage(s, target, attack);
            self.damage(s, source, defend);
            if excess > 0 {
                let base = s.player(s.active.other()).base;
                s.card_mut(base).damage += excess;
            }
            let source_dead = s.card(source).damage >= self.hp(s, source);
            let target_dead = s.card(target).damage >= self.hp(s, target);
            if source_dead {
                self.defeat(s, source)?;
            }
            if target_dead {
                self.defeat(s, target)?;
            }
        } else {
            s.card_mut(target).damage += attack;
        }
        self.check_win(s);
        if s.is_terminal() {
            self.finish(s)?;
        } else {
            if (s.after_attack_triggers != 0 || s.after_attack_programs != 0)
                && self.in_arena(s, source)
            {
                s.pending_programs = s.after_attack_programs;
                s.after_attack_programs = 0;
                s.pending_triggers = s.after_attack_triggers;
                s.after_attack_triggers = 0;
                s.trigger_context = 1;
                self.process_triggers(s)?;
            } else {
                self.finish(s)?;
            }
        }
        Ok(())
    }
    fn defeat(&self, s: &mut State, id: CardId) -> Result<(), String> {
        let owner = s.card(id).owner;
        let leader = id == s.player(owner).leader;
        let token = self.def(s, id).info.is("token");
        let p = s.player_mut(owner);
        p.ground.remove(id);
        p.space.remove(id);
        if !leader && !token {
            p.discard.push(id)?;
        }
        let c = s.card_mut(id);
        c.damage = 0;
        c.shield = 0;
        c.experience = 0;
        c.exhausted = leader;
        c.deployed = false;
        Ok(())
    }
    fn check_win(&self, s: &mut State) {
        for seat in [Seat::P1, Seat::P2] {
            let id = s.player(seat).base;
            let hp = self.def(s, id).info.hp.unwrap_or(30) as u16;
            s.card_mut(id).damage = s.card(id).damage.min(hp);
        }
        let dead = [
            s.card(s.players[0].base).damage
                >= self.def(s, s.players[0].base).info.hp.unwrap_or(30) as u16,
            s.card(s.players[1].base).damage
                >= self.def(s, s.players[1].base).info.hp.unwrap_or(30) as u16,
        ];
        if s.outcome == 0 {
            s.outcome = match dead {
                [true, true] => 3,
                [true, false] => 2,
                [false, true] => 1,
                _ => 0,
            };
        }
        if s.outcome != 0 {
            s.decision = Decision::Terminal;
        }
    }
    fn finish(&self, s: &mut State) -> Result<(), String> {
        if s.is_terminal() {
            s.prev_passed = false;
            if !s.regroup && !s.player(s.active.other()).out {
                s.active = s.active.other();
            }
            s.decision = Decision::Terminal;
            return Ok(());
        }
        s.prev_passed = false;
        s.after_attack_triggers = 0;
        s.after_attack_programs = 0;
        s.pending_programs = 0;
        s.ability_program = 0;
        s.ability_pc = 0;
        s.ability_target = 0;
        s.ability_result = 0;
        s.ability_succeeded = false;
        s.ability_return = 0;
        s.ability_committed = false;
        s.source = 0;
        s.target = 0;
        s.pending_triggers = 0;
        s.trigger_context = 0;
        s.ambush = false;
        self.advance(s)
    }
    fn advance(&self, s: &mut State) -> Result<(), String> {
        if s.players.iter().all(|p| p.out) {
            s.regroup = true;
            s.players[0].out = false;
            s.players[1].out = false;
            s.initiative_claimed = false;
            s.prev_passed = false;
            for seat in [Seat::P1, Seat::P2] {
                for _ in 0..2 {
                    if let Some(id) = s.player_mut(seat).deck.pop_front() {
                        s.player_mut(seat).hand.push(id)?;
                    } else {
                        let base = s.player(seat).base;
                        s.card_mut(base).damage += 3;
                    }
                }
            }
            self.check_win(s);
            if !s.is_terminal() {
                s.decision = Decision::Resource;
                s.resource_done = [false; 2];
                s.resource_selected = [0; 2];
                s.active = Seat::P1;
            }
        } else {
            if !s.player(s.active.other()).out {
                s.active = s.active.other();
            }
            s.decision = Decision::Window;
        }
        Ok(())
    }
    fn end_regroup(&self, s: &mut State) -> Result<(), String> {
        for seat in [Seat::P1, Seat::P2] {
            let id = s.resource_selected[seat.index()];
            if id != 0 {
                s.player_mut(seat).hand.remove(id);
                s.player_mut(seat).resources.push(id)?;
            }
            let p = *s.player(seat);
            for &id in p
                .resources
                .as_slice()
                .iter()
                .chain(p.ground.as_slice())
                .chain(p.space.as_slice())
                .chain(std::iter::once(&p.leader))
            {
                s.card_mut(id).exhausted = false;
            }
            s.player_mut(seat).out = false;
        }
        s.round = s.round.checked_add(1).ok_or("round capacity exceeded")?;
        s.regroup = false;
        s.active = s.initiative;
        s.decision = Decision::Window;
        s.resource_selected = [0; 2];
        s.resource_done = [false; 2];
        s.prev_passed = false;
        Ok(())
    }
    fn load_card(&self, s: &mut State, v: &Value, owner: Seat) -> Result<CardId, String> {
        let text = v["id"].as_str().ok_or("card missing id")?;
        let id = cid(text)?;
        let code = v["setCode"]
            .as_str()
            .ok_or_else(|| format!("card {text} missing setCode"))?;
        let def = *self.by_code.get(code).ok_or_else(|| {
            format!(
                "unsupported card {} ({code})",
                v["name"].as_str().unwrap_or(text)
            )
        })?;
        if s.card(id).present && s.card(id).def != def {
            return Err(format!("conflicting card identity {text}"));
        }
        let c = s.card_mut(id);
        c.present = true;
        c.def = def;
        c.owner = owner;
        if v.get("damage").is_some() {
            c.damage = n(v, "damage");
        }
        if v.get("exhausted").is_some() {
            c.exhausted = b(v, "exhausted");
        }
        if v.get("deployed").is_some() {
            c.deployed = b(v, "deployed");
        }
        if v.get("epicUsed").is_some() {
            c.epic_used = b(v, "epicUsed");
        }
        s.next_id = s.next_id.max(id + 1);
        if let Some(upgrades) = v["upgrades"].as_array() {
            for u in upgrades {
                let uid = self.load_card(s, u, owner)?;
                let prior = if s.card(uid).def == self.shield_def {
                    let prior = s.card(id).shield;
                    s.card_mut(id).shield = uid;
                    prior
                } else if Some(s.card(uid).def) == self.experience_def {
                    let prior = s.card(id).experience;
                    s.card_mut(id).experience = uid;
                    prior
                } else {
                    return Err(format!("unsupported upgrade {}", u));
                };
                s.card_mut(uid).next_token = prior;
            }
        }
        Ok(id)
    }
    pub fn load_state(&self, v: &Value) -> Result<State, String> {
        if let Some(catalogue) = &self.catalogue {
            crate::validation::validate_state_with_catalogue(v, &catalogue.metadata)?;
        } else {
            crate::validation::validate_state(v)?;
        }
        if v["phase"].as_str() != Some("action") {
            return Err("positions must start at an action window in the action phase".into());
        }
        let mut s = State::default();
        s.round = n(v, "round");
        if s.round == 0 {
            return Err("invalid round".into());
        }
        s.initiative = Seat::parse(v["initiative"].as_str().ok_or("missing initiative")?)?;
        s.initiative_claimed = b(v, "initiativeClaimed");
        s.prev_passed = b(v, "prevPassed");
        s.active = Seat::parse(
            v["actor"]
                .as_str()
                .or(v["activePlayer"].as_str())
                .ok_or("missing actor")?,
        )?;
        for seat in [Seat::P1, Seat::P2] {
            let p = &v["players"][seat.as_str()];
            let base = self.load_card(&mut s, &p["base"], seat)?;
            let leader = self.load_card(&mut s, &p["leader"], seat)?;
            s.player_mut(seat).base = base;
            s.player_mut(seat).leader = leader;
            s.player_mut(seat).out = b(p, "out");
            for name in ["hand", "deck", "resources", "discard", "ground", "space"] {
                let mut zone = Zone::default();
                for c in p[name]
                    .as_array()
                    .ok_or_else(|| format!("missing {seat:?}.{name}"))?
                {
                    let id = self.load_card(&mut s, c, seat)?;
                    if zone.contains(id) {
                        return Err(format!("duplicate {} in {name}", c["id"]));
                    }
                    zone.push(id)?;
                }
                match name {
                    "hand" => s.player_mut(seat).hand = zone,
                    "deck" => s.player_mut(seat).deck = zone,
                    "resources" => s.player_mut(seat).resources = zone,
                    "discard" => s.player_mut(seat).discard = zone,
                    "ground" => s.player_mut(seat).ground = zone,
                    _ => s.player_mut(seat).space = zone,
                };
            }
        }
        if let Some(next) = v["nextCardId"].as_u64() {
            if next >= MAX_CARDS as u64 {
                return Err("card capacity exceeded".into());
            }
            s.next_id = s.next_id.max(next as u16 + 1);
        } else {
            return Err(
                "full state missing nextCardId: regenerate the trace with the current exporter"
                    .into(),
            );
        }
        for seat in [Seat::P1, Seat::P2] {
            let p = &v["players"][seat.as_str()];
            for name in ["ground", "space"] {
                for c in p[name].as_array().unwrap() {
                    let id = cid(c["id"].as_str().unwrap())?;
                    if c["power"].as_u64() != Some(self.power(&s, id, false) as u64)
                        || c["hp"].as_u64() != Some(self.hp(&s, id) as u64)
                    {
                        return Err(format!(
                            "unit stats mismatch on {}: engine {}/{}, Rust {}/{}",
                            c["id"],
                            c["power"],
                            c["hp"],
                            self.power(&s, id, false),
                            self.def(&s, id).info.hp.unwrap_or(0)
                        ));
                    }
                }
            }
        }
        s.outcome = match v["winner"].as_str() {
            Some("p1") => 1,
            Some("p2") => 2,
            Some("draw") => 3,
            _ => 0,
        };
        if s.outcome != 0 {
            s.decision = Decision::Terminal;
        }
        Ok(s)
    }
    fn card_ref(&self, s: &State, id: CardId) -> Value {
        let d = self.def(s, id);
        json!({"id":format!("c{}",id-1),"setCode":d.code,"name":d.info.internal_name})
    }
    pub fn snapshot(&self, s: &State) -> Value {
        let mut players = serde_json::Map::new();
        for seat in [Seat::P1, Seat::P2] {
            let p = s.player(seat);
            let mut base = self.card_ref(s, p.base);
            base["damage"] = json!(s.card(p.base).damage);
            base["hp"] = json!(self.def(s, p.base).info.hp.unwrap_or(30));
            base["epicUsed"] = json!(s.card(p.base).epic_used);
            let mut leader = self.card_ref(s, p.leader);
            leader["deployed"] = json!(s.card(p.leader).deployed);
            leader["exhausted"] = json!(s.card(p.leader).exhausted);
            leader["epicUsed"] = json!(s.card(p.leader).epic_used);
            let refs = |z: &Zone| -> Value {
                Value::Array(
                    z.as_slice()
                        .iter()
                        .map(|&id| self.card_ref(s, id))
                        .collect(),
                )
            };
            let resources: Vec<_> = p
                .resources
                .as_slice()
                .iter()
                .map(|&id| {
                    let mut v = self.card_ref(s, id);
                    v["exhausted"] = json!(s.card(id).exhausted);
                    v
                })
                .collect();
            let arena = |z: &Zone| -> Value {
                Value::Array(
                    z.as_slice()
                        .iter()
                        .map(|&id| {
                            let mut v = self.card_ref(s, id);
                            let c = s.card(id);
                            v["damage"] = json!(c.damage);
                            v["exhausted"] = json!(c.exhausted);
                            v["power"] = json!(self.power(s, id, false));
                            v["hp"] = json!(self.hp(s, id));
                            let mut ids = Vec::new();
                            for mut token in [c.shield, c.experience] {
                                while token != 0 {
                                    ids.push(token);
                                    token = s.card(token).next_token;
                                }
                            }
                            ids.sort_unstable();
                            let upgrades: Vec<_> = ids
                                .into_iter()
                                .map(|id| {
                                    let mut u = self.card_ref(s, id);
                                    u["token"] = json!(true);
                                    u
                                })
                                .collect();
                            v["upgrades"] = json!(upgrades);
                            v
                        })
                        .collect(),
                )
            };
            players.insert(seat.as_str().into(),json!({"base":base,"leader":leader,"hand":refs(&p.hand),"deck":refs(&p.deck),"resources":resources,"discard":refs(&p.discard),"ground":arena(&p.ground),"space":arena(&p.space),"out":p.out}));
        }
        let winner = if s.outcome == 3 {
            Some("draw")
        } else {
            s.winner().map(Seat::as_str)
        };
        json!({"round":s.round,"phase":if s.regroup{"regroup"}else{"action"},"initiative":s.initiative.as_str(),"initiativeClaimed":s.initiative_claimed,"prevPassed":s.prev_passed,"activePlayer":if s.regroup{None}else{Some(s.active.as_str())},"actor":if s.is_action_window(){Some(s.active.as_str())}else{None},"winner":winner,"nextCardId":s.next_id-1,"players":players})
    }
}

#[cfg(test)]
#[path = "simulator_tests.rs"]
mod tests;
