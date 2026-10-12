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
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum RulesBackend { #[default] Auto, Interpreter, Aot }

pub struct Engine {
    pool_hash: String,
    pub definitions: Vec<Definition>,
    by_code: HashMap<String, u16>,
    shield_def: u16,
    experience_def: Option<u16>,
    catalogue: Option<Catalogue>,
    rules_backend: RulesBackend,
    rules_instrumentation: bool,
    rules_hits: std::sync::Mutex<std::collections::BTreeMap<usize, [u64;2]>>,
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
            rules_backend: RulesBackend::Auto,
            rules_instrumentation: false,
    rules_hits: Default::default(),
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
    fn arena_units(&self,s:&State)->Vec<CardId> {
        if s.arena_order_exact {s.arena_unit_order.iter().flat_map(|arena|arena.as_slice()).copied().collect()}
        else {
            // Compatibility, not inferred engine order. Historical no-upgrade
            // traces predate global-order evidence and keep their old semantics.
            s.players.iter().flat_map(|p|p.ground.as_slice().iter().chain(p.space.as_slice())).copied().collect()
        }
    }
    fn load_arena_order(&self,s:&mut State,v:&Value)->Result<(),String> {
        if let Some(order)=v.get("arenaUnitOrder") {
            let object=order.as_object().ok_or("arenaUnitOrder must be an object")?;
            if object.len()!=2 || !object.contains_key("ground") || !object.contains_key("space") {return Err("arenaUnitOrder must contain ground and space only".into());}
            for (index,name) in ["ground","space"].iter().enumerate() {
                let expected=s.players.iter().flat_map(|p|if index==0 {p.ground.as_slice()}else{p.space.as_slice()}).copied().collect::<std::collections::HashSet<_>>();
                let mut actual=ArenaOrder::default();
                for id in order[name].as_array().ok_or("arenaUnitOrder arena must be an array")? {
                    let id=cid(id.as_str().ok_or("arenaUnitOrder needs stable card IDs")?)?;
                    if !expected.contains(&id) {return Err("arenaUnitOrder contains foreign/wrong-arena/nonunit card".into());}
                    actual.push(id)?;
                }
                if actual.len as usize!=expected.len() {return Err("arenaUnitOrder missing arena unit".into());}
                for player in s.players {
                    let own=if index==0 {player.ground.as_slice()}else{player.space.as_slice()};
                    let subsequence=actual.as_slice().iter().copied().filter(|id|own.contains(id)).collect::<Vec<_>>();
                    if subsequence.as_slice()!=own {return Err("arenaUnitOrder conflicts with controller arena subsequence".into());}
                }
                s.arena_unit_order[index]=actual;
            }
            s.arena_order_exact=true;
        }else{
            if (1..s.next_id).any(|id|s.card(id).present && self.def(s,id).info.is("upgrade") && !self.def(s,id).info.is("token")) {return Err("ordinary upgrade imports require explicit arenaUnitOrder, including future upgrades in hidden zones".into());}
            s.arena_order_exact=false;
            for index in 0..2 {for player in s.players {for &id in if index==0 {player.ground.as_slice()}else{player.space.as_slice()} {s.arena_unit_order[index].push(id)?;}}}
        }
        Ok(())
    }
    fn attached_in_play(&self,s:&State,id:CardId)->bool {
        s.card(id).parent!=0 && self.in_arena(s,s.card(id).parent)
    }
    fn upgrades(&self,s:&State,parent:CardId)->Vec<CardId> {
        let mut ids=vec![];let mut id=s.card(parent).upgrades;
        while id!=0 {ids.push(id);id=s.card(id).next_upgrade;}
        ids
    }
    fn attach(&self,s:&mut State,id:CardId,parent:CardId) {
        let ids=self.upgrades(s,parent);
        if let Some(&last)=ids.last() {s.card_mut(last).next_upgrade=id;}else{s.card_mut(parent).upgrades=id;}
        s.card_mut(id).parent=parent;s.card_mut(id).next_upgrade=0;
    }
    fn detach(&self,s:&mut State,id:CardId) {
        let parent=s.card(id).parent;if parent==0 {return;}
        for experience in [false,true] {
            let mut token=if experience {s.card(parent).experience}else{s.card(parent).shield};let mut previous=0;
            while token!=0 && token!=id {previous=token;token=s.card(token).next_token;}
            if token!=0 {let next=s.card(token).next_token;if previous==0 {if experience {s.card_mut(parent).experience=next;}else{s.card_mut(parent).shield=next;}}else{s.card_mut(previous).next_token=next;}s.card_mut(token).next_token=0;}
        }
        let ids=self.upgrades(s,parent);let next=s.card(id).next_upgrade;
        if let Some(i)=ids.iter().position(|c|*c==id) {if i==0 {s.card_mut(parent).upgrades=next;}else{s.card_mut(ids[i-1]).next_upgrade=next;}}
        s.card_mut(id).parent=0;s.card_mut(id).next_upgrade=0;
    }
    fn validate_attachment_links(&self,s:&State)->Result<(),String> {
        let mut seen=std::collections::HashSet::new();
        for parent in 1..s.next_id {
            let mut id=s.card(parent).upgrades;let mut chain=std::collections::HashSet::new();
            while id!=0 {
                if id>=s.next_id || !s.card(id).present || !chain.insert(id) || !seen.insert(id) {return Err("invalid or cyclic attachment chain".into());}
                if s.card(id).parent!=parent || !self.in_arena(s,parent) || !self.def(s,id).info.is("upgrade") || s.card(id).upgrades!=0 {return Err("invalid attachment parent/type/arena".into());}
                id=s.card(id).next_upgrade;
            }
            for (head,def) in [(s.card(parent).shield,Some(self.shield_def)),(s.card(parent).experience,self.experience_def)] {
                let mut id=head;let mut tokens=std::collections::HashSet::new();
                while id!=0 {
                    if !tokens.insert(id)||!chain.contains(&id)||Some(s.card(id).def)!=def {return Err("invalid attachment token chain".into());}
                    id=s.card(id).next_token;
                }
                if chain.iter().any(|id|Some(s.card(*id).def)==def && !tokens.contains(id)) {return Err("unreachable token type link".into());}
            }
        }
        if (1..s.next_id).any(|id|s.card(id).parent!=0 && !seen.contains(&id)) {return Err("unreachable parent attachment link".into());}
        Ok(())
    }
    fn upgrade_stats(&self,s:&State,parent:CardId)->(i64,i64) {
        self.upgrades(s,parent).iter().filter(|id|!self.def(s,**id).info.is("token")).fold((0,0),|a,id| {
            let info=&self.def(s,*id).info;(a.0+info.upgrade_power.unwrap_or(0) as i64,a.1+info.upgrade_hp.unwrap_or(0) as i64)
        })
    }
    fn upgrade_targets(&self,s:&State,id:CardId)->Vec<CardId> {
        self.arena_units(s).into_iter().filter(|parent| {
            self.def(s,*parent).info.is("unit") || (self.def(s,*parent).info.is("leader") && s.card(*parent).deployed)
        }).filter(|parent|self.def(s,id).programs.attach_condition.as_ref().map_or(true,|e|self.attachment_condition(s,id,*parent,e))).collect()
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
    fn raw_power(&self,s:&State,id:CardId,attacking:bool)->i64 {
        self.def(s,id).info.power.unwrap_or(0) as i64 + if self.keyword_amount(s,id,"grit")>0 {s.card(id).damage as i64}else{0}+if attacking {self.keyword_amount(s,id,"raid") as i64}else{0}+self.token_count(s,s.card(id).experience) as i64+s.card(id).phase_power as i64+self.constant_stats(s,id).0+self.upgrade_stats(s,id).0
    }
    pub fn power(&self,s:&State,id:CardId,attacking:bool)->u16 {u16::try_from(self.raw_power(s,id,attacking).max(0)).expect("power exceeds validated compact capacity")}
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
        let sentinel = self.keyword_amount(s, source, "saboteur") == 0
            && zone
                .as_slice()
                .iter()
                .any(|&c| self.keyword_amount(s, c, "sentinel") > 0);
        let mut out: Vec<_> = zone
            .as_slice()
            .iter()
            .copied()
            .filter(|&c| !sentinel || self.keyword_amount(s, c, "sentinel") > 0)
            .filter(|&c| self.keyword_amount(s,c,"sentinel") > 0 || self.keyword_amount(s,c,"hidden") == 0 || !s.card(c).hidden_qualified())
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
                    if self.def(s,id).info.is("upgrade") && self.upgrade_targets(s,id).is_empty() {continue;}
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
            Decision::UpgradeTarget => {
                out.push(Action::button("Cancel","cancel"));
                for id in self.upgrade_targets(s,s.source) {out.push(self.card_action(s,id));}
            }
            Decision::Unique => {
                if self.def(s,s.source).info.is("upgrade") {
                    for id in (1..s.next_id).filter(|id|*id!=s.source).chain(std::iter::once(s.source)) {
                        if s.card(id).owner==s.active && self.attached_in_play(s,id) && s.card(id).def==s.card(s.source).def {out.push(self.card_action(s,id));}
                    }
                }else{
                    for &id in p.ground.as_slice().iter().chain(p.space.as_slice()) {if s.card(id).def==s.card(s.source).def {out.push(self.card_action(s,id));}}
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
            Decision::DeathPlayer | Decision::DeathOrder | Decision::DeathBatch | Decision::AbilityMenu
            | Decision::AbilityTarget
            | Decision::AbilityOptional
            | Decision::AbilityNoEffect
            | Decision::AbilityDistribute
            | Decision::AbilityGroupShield | Decision::AbilityDiscard => unreachable!(),
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
            T_RESTORE => format!("Restore {}", s.attack_restore),
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
            T_AMBUSH => {
                self.in_arena(s, s.source) && !self.attack_targets(s, s.source, true).is_empty()
            }
            T_SHIELD => self.in_arena(s, s.source),
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
        self.check_stat_capacity(s)?;
        if !self.legal_actions(s).contains(a) {
            return Err(format!("illegal action {} at {:?}", a.key(), s.decision));
        }
        if self.is_ability_decision(s.decision) {
            return self.apply_ability_action(s, a);
        }
        let mut t = *s;
        if t.decision==Decision::Window {t.action_player=Some(t.active);}
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
                    if self.def(&t,id).info.is("upgrade") {t.source=id;t.decision=Decision::UpgradeTarget;return Ok(t);}
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
                    t.card_mut(id).set_hidden_qualified(true);
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
            Decision::UpgradeTarget => {
                if arg=="cancel" {self.cancel(&mut t);}else{
                    let upgrade=t.source;self.spend(&mut t,self.cost(s,upgrade));t.player_mut(seat).hand.remove(upgrade);
                    self.attach(&mut t,upgrade,id);t.trigger_context=1;
                    if self.def(&t,upgrade).info.unique && self.duplicates(&t,upgrade)>1 {
                        let same=self.upgrades(&t,id).into_iter().filter(|other|t.card(*other).def==t.card(upgrade).def && t.card(*other).owner==seat).collect::<Vec<_>>();
                        if same.len()==self.duplicates(&t,upgrade) && same.len()>1 {self.settle_enter_triggers(&mut t,Some(same[0]))?;}else{t.decision=Decision::Unique;}
                    }else{self.enter_triggers(&mut t)?;}
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
                    t.card_mut(leader).set_hidden_qualified(true);
                    self.add_arena(&mut t, leader)?;
                    t.source = leader;
                    self.enter_triggers(&mut t)?;
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
                    t.attack_source = source;t.attack_defender=id;
                    // The declaration registers before queued framework deaths
                    // physically remove combatants. Copy only for defender rules.
                    let declaration_context=if self.has_defense_registration(&t,id) {Some(t)}else{None};
                    self.sweep_stat_defeats(&mut t)?;
                    t.pending_triggers = 0;
                    let d = self.def(&t, source);
                    t.attack_restore = self.keyword_amount(&t, source, "restore");
                    if self.has_keyword(&t, source, "restore") {
                        t.pending_triggers |= T_RESTORE;
                    }
                    if self.keyword_amount(&t, source, "saboteur") > 0 && self.in_arena(&t, id) {
                        t.pending_triggers |= T_SABOTEUR;
                    }
                    if self.catalogue.is_none() && (d.code == "SOR_014" || d.code == "IBH_053") {
                        t.pending_triggers |= T_LEADER;
                    }
                    self.queue_programs(&mut t, "onAttack");
                    if let Some(context)=declaration_context.as_ref() {
                        if !self.capture_defense_window(&mut t,context)? {self.process_triggers(&mut t)?;}
                    } else {self.process_triggers(&mut t)?;}
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
                self.settle_enter_triggers(&mut t, Some(id))?;
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
                t.attack_shield_opponent_first=a.arg.as_ref().and_then(Value::as_u64)==Some(1);
                t.trigger_context = 3;
                self.combat(&mut t)?;
            }
            Decision::DeathPlayer | Decision::DeathOrder | Decision::DeathBatch | Decision::AbilityMenu
            | Decision::AbilityTarget
            | Decision::AbilityOptional
            | Decision::AbilityNoEffect
            | Decision::AbilityDistribute
            | Decision::AbilityGroupShield | Decision::AbilityDiscard => unreachable!(),
            Decision::Terminal => return Err("game is over".into()),
        }
        self.sweep_stat_defeats(&mut t)?;
        Ok(t)
    }
    fn duplicates(&self, s: &State, id: CardId) -> usize {
        (1..s.next_id).filter(|c|s.card(*c).owner==s.card(id).owner && s.card(*c).def==s.card(id).def && (self.in_arena(s,*c)||self.attached_in_play(s,*c))).count()
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
        if space {p.space.push(id)?;}else{p.ground.push(id)?;}
        s.arena_unit_order[usize::from(space)].push(id)
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
        s.attack_source=0;s.attack_defender=0;
        s.source = 0;
        s.target = 0;
        s.trigger_context = 0;
        s.pending_triggers = 0;
        s.ambush = false;
        s.ability_program = 0;
        s.ability_pc = 0;
        s.ability_target = 0;
        s.attack_shield_opponent_first=false;
        s.ability_selection = Selection::default();
        s.event_group = EventGroupState::default();
        s.ability_result = 0;
        s.ability_succeeded = false;
        s.ability_return = 0;
        s.ability_committed = false;
        s.pending_programs = 0;
        s.after_attack_programs = 0;
        s.decision = Decision::Window;
    }
    fn enter_triggers(&self, s: &mut State) -> Result<(), String> {
        self.settle_enter_triggers(s, None)
    }
    fn settle_enter_triggers(
        &self,
        s: &mut State,
        unique_defeat: Option<CardId>,
    ) -> Result<(), String> {
        // Registration sees pending-defeat cards in the arena, with the chosen
        // unique copy's ongoing effects disabled. Resolution sees settled deaths.
        s.decision = Decision::Window;
        s.disabled_ongoing_source = unique_defeat.unwrap_or(0);
        self.capture_enter_triggers(s);
        s.disabled_ongoing_source = 0;
        if let Some(id) = unique_defeat {
            self.defeat(s, id)?;
        }
        self.sweep_stat_defeats(s)?;
        self.process_triggers(s)
    }
    fn capture_enter_triggers(&self, s: &mut State) {
        let flags = self.effective_flags(s, s.source);
        s.pending_triggers = if flags & SHIELDED != 0 { T_SHIELD } else { 0 }
            | if flags & AMBUSH != 0 { T_AMBUSH } else { 0 };
        s.trigger_context = 1;
        // Standard WhenPlayed abilities watch OnCardPlayed, while keyword
        // Ambush/Shielded also watch OnLeaderDeployed.
        if !self.def(s, s.source).info.is("leader") {
            self.queue_programs(s, "whenPlayed");
        }
    }
    fn process_triggers(&self, s: &mut State) -> Result<(), String> {
        if s.trigger_context==4 {return self.process_deaths(s);}
        self.merge_enter_deaths(s)?;
        if self.open_deaths(s,2)? {return Ok(());}
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
                    .saturating_sub(s.attack_restore);
            }
            T_SABOTEUR => {let mut token=s.card(s.target).shield;while token!=0 {let next=s.card(token).next_token;self.detach(s,token);token=next;}s.card_mut(s.target).shield=0;}
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
                if !self.in_arena(s, s.source) {
                    return self.process_triggers(s);
                }
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
                self.attach(s,id,s.source);
            }
            T_AMBUSH => {
                if self.trigger_effect(s, T_AMBUSH) {
                    s.decision = Decision::Ambush;
                    return Ok(());
                }
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
            self.detach(s,token);s.card_mut(token).next_token=0;
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
            let source_damage_before=s.card(source).damage;
            let target_damage_before=s.card(target).damage;
            let remaining = self.hp(s, target).saturating_sub(s.card(target).damage);
            let excess = if self.keyword_amount(s, source, "overwhelm") > 0 && s.card(target).shield == 0 {
                attack.saturating_sub(remaining)
            } else {
                0
            };
            if s.trigger_context==3 && s.card(source).shield!=0 && s.card(target).shield!=0 && attack>0 && defend>0 {
                let (first,second)=if s.attack_shield_opponent_first { (target,source) } else { (source,target) };
                let (first_token,second_token)=self.combat_shield_contexts(s,first,second);
                self.remove_group_shield(s,first,first_token); self.remove_group_shield(s,second,second_token);
            } else {
                self.damage(s, target, attack);
                self.damage(s, source, defend);
            }
            if excess > 0 {
                let base = s.player(s.active.other()).base;
                s.card_mut(base).damage += excess;
            }
            // Only actual damage invokes deferred damage-defeat callbacks.
            // Shield replacement can instead remove an HP grant: those deaths
            // belong to the later framework sweep in global arena order.
            let mut dead=vec![];
            for (id,before) in [(target,target_damage_before),(source,source_damage_before)] {
                if s.card(id).damage>before && s.card(id).damage>=self.hp(s,id) {dead.push(id);}
            }
            for id in self.arena_units(s) {if s.card(id).damage>=self.hp(s,id) && !dead.contains(&id) {dead.push(id);}}
            self.defeat_many(s,&dead)?;
        } else {
            s.card_mut(target).damage += attack;
        }
        self.sweep_stat_defeats(s)?;
        self.check_win(s);
        if self.open_deaths(s,5)? {return Ok(());}
        self.combat_after_damage(s)
    }
    fn combat_after_damage(&self,s:&mut State)->Result<(),String> {
        let source=s.source;
        s.attack_source=0;s.attack_defender=0;
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
        if !self.in_arena(s,id) && !self.attached_in_play(s,id) {return Ok(());}
        self.capture_death(s,id)?;
        self.leave_play(s, id)
    }
    fn defeat_many(&self,s:&mut State,ids:&[CardId])->Result<(),String> {
        for &id in ids {self.capture_death(s,id)?;}
        let attachments=ids.iter().flat_map(|id|self.upgrades(s,*id)).collect::<Vec<_>>();
        // The pinned engine gives cleanup events order -1, then uses a unary
        // sort comparator (event => event.order). Its observed order is reverse
        // cleanup insertion, before the primary parent handlers.
        for upgrade in attachments.into_iter().rev() {self.leave_play_primary(s,upgrade)?;}
        for &id in ids {if self.in_arena(s,id)||self.attached_in_play(s,id) {self.leave_play_primary(s,id)?;}}
        Ok(())
    }
    fn leave_play(&self,s:&mut State,id:CardId)->Result<(),String> {
        let attachments=self.upgrades(s,id);
        for upgrade in attachments.into_iter().rev() {self.leave_play_primary(s,upgrade)?;}
        self.leave_play_primary(s,id)?;
        Ok(())
    }
    fn leave_play_primary(&self, s: &mut State, id: CardId) -> Result<(), String> {
        self.leave_play_primary_to_discard(s,id,true)
    }
    // A returned upgrade moves directly to hand, never through discard. Keep
    // the common detach/state-reset path without consuming a discard slot.
    fn leave_play_primary_to_discard(&self, s: &mut State, id: CardId, discard: bool) -> Result<(), String> {
        self.detach(s,id);
        let owner = s.card(id).owner;
        let leader = id == s.player(owner).leader;
        let token = self.def(s, id).info.is("token");
        s.arena_unit_order[0].remove(id);s.arena_unit_order[1].remove(id);
        let p = s.player_mut(owner);
        p.ground.remove(id);
        p.space.remove(id);
        if discard && !leader && !token {
            p.discard.push(id)?;
        }
        let c = s.card_mut(id);
        if !leader && !token {c.set_hidden_qualified(false);}
        c.damage = 0;
        c.phase_power = 0;
        c.phase_hp = 0;
        c.phase_keyword_values = [0; 2];
        c.phase_keyword_presence = 0;
        c.phase_lost_keywords = 0;
        c.clear_hidden_phase_effects();
        c.shield = 0;
        c.experience = 0;
        c.upgrades = 0;
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
        self.sweep_stat_defeats(s)?;
        if self.open_deaths(s,3)? {return Ok(());}
        if s.death_depth>0 {return self.process_deaths(s);}
        if s.is_terminal() {
            s.prev_passed = false;
            if !s.regroup && !s.player(s.active.other()).out {
                s.active = s.active.other();
            }
            if !s.regroup {s.action_player=Some(s.active);}
            s.decision = Decision::Terminal;
            return Ok(());
        }
        s.prev_passed = false;
        s.attack_source=0;s.attack_defender=0;
        s.after_attack_triggers = 0;
        s.after_attack_programs = 0;
        s.pending_programs = 0;
        s.ability_program = 0;
        s.ability_pc = 0;
        s.ability_target = 0;
        s.attack_shield_opponent_first=false;
        s.ability_selection = Selection::default();
        s.event_group = EventGroupState::default();
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
            s.action_player=None;
            for id in 1..s.next_id {
                s.card_mut(id).set_hidden_qualified(false);
                s.card_mut(id).phase_power = 0;
                s.card_mut(id).phase_hp = 0;
                s.card_mut(id).phase_keyword_values = [0; 2];
                s.card_mut(id).phase_keyword_presence = 0;
                s.card_mut(id).phase_lost_keywords = 0;
                s.card_mut(id).clear_hidden_phase_effects();
            }
            self.sweep_stat_defeats(s)?;
            if self.open_deaths(s,4)? {return Ok(());}
            return self.advance_after_expiry(s);
        } else {
            if !s.player(s.active.other()).out {s.active=s.active.other();}
            s.decision=Decision::Window;s.action_player=Some(s.active);
        }
        Ok(())
    }
    fn advance_after_expiry(&self,s:&mut State)->Result<(),String> {
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
        s.active = s.initiative;s.action_player=Some(s.active);
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
        if let Some(q)=v.get("hiddenQualified") {c.set_hidden_qualified(q.as_bool().ok_or("hiddenQualified must be boolean")?);}
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
        if let Some(stats) = v.get("phaseStats") {
            c.phase_power = stats["power"]
                .as_i64()
                .ok_or("phase power must be signed integer")? as i32;
            c.phase_hp = stats["hp"]
                .as_i64()
                .ok_or("phase HP must be signed integer")? as i32;
        }
        if let Some(keywords) = v.get("phaseKeywords") {
            for (keyword, amount) in keywords.as_object().ok_or("phaseKeywords must be object")? {
                let index = crate::ability_ir::CORE_KEYWORDS.iter().position(|k| k == keyword).ok_or("unsupported phase keyword")?;
                let amount = amount.as_u64().and_then(|n| u16::try_from(n).ok()).ok_or("phase keyword amount must be bounded integer")?;
                if index == 7 && amount == 0 { return Err("zero phase Restore requires verified nullable trigger titles".into()); }
                if let Some(slot) = crate::ability_ir::numeric_keyword_slot(index) { c.phase_keyword_values[slot] = amount; } else if amount != 1 { return Err("boolean phase keyword amount must be one".into()); }
                c.add_phase_keyword(index);
            }
        }
        if let Some(keywords) = v.get("phaseLostKeywords") {
            for keyword in keywords.as_array().ok_or("phaseLostKeywords must be array")? {
                let index = crate::ability_ir::CORE_KEYWORDS.iter().position(|k| Some(*k) == keyword.as_str()).ok_or("unsupported lost keyword")?;
                c.add_lost_keyword(index);
            }
        }
        s.next_id = s.next_id.max(id + 1);
        if let Some(upgrades) = v["upgrades"].as_array() {
            for u in upgrades {
                let upgrade_owner=if u["token"]==false {Seat::parse(u["controller"].as_str().ok_or("ordinary upgrade missing controller")?)?}else{owner};
                if u["token"]==false && u["owner"].as_str()!=Some(upgrade_owner.as_str()) {return Err("foreign-controlled upgrade imports are unsupported".into());}
                let uid = self.load_card(s, u, upgrade_owner)?;
                let prior = if s.card(uid).def == self.shield_def {
                    let prior = s.card(id).shield;
                    s.card_mut(id).shield = uid;
                    prior
                } else if Some(s.card(uid).def) == self.experience_def {
                    let prior = s.card(id).experience;
                    s.card_mut(id).experience = uid;
                    prior
                } else {
                    if !self.def(s,uid).info.is("upgrade") || self.def(s,uid).info.is("token") {return Err("unsupported attachment type".into());}
                    0
                };
                s.card_mut(uid).next_token = prior;
                self.attach(s,uid,id);
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
        s.hidden_history_exact=v.get("hiddenHistoryVersion").is_some();
        if !s.hidden_history_exact && self.needs_hidden_history() {return Err("selected pool requires explicit Hidden phase history".into());}
        s.round = n(v, "round");
        if s.round == 0 {
            return Err("invalid round".into());
        }
        s.initiative = Seat::parse(v["initiative"].as_str().ok_or("missing initiative")?)?;
        s.action_player=v["activePlayer"].as_str().map(Seat::parse).transpose()?;
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
        self.load_arena_order(&mut s,v)?;
        self.validate_attachment_links(&s)?;
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
        self.check_stat_capacity(&s)?;
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
        self.check_stat_capacity(&s)?;
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
                            if s.hidden_history_exact {v["hiddenQualified"]=json!(c.hidden_qualified());}
                            if c.phase_power != 0 || c.phase_hp != 0 {
                                v["phaseStats"] = json!({"power":c.phase_power,"hp":c.phase_hp});
                            }
                            if c.phase_keyword_mask() != 0 {
                                let mut keywords = serde_json::Map::new();
                                for (i, name) in crate::ability_ir::CORE_KEYWORDS.iter().enumerate() { if c.phase_keyword_mask() & (1 << i) != 0 { keywords.insert((*name).into(), json!(c.phase_keyword_amount(i))); } }
                                v["phaseKeywords"] = Value::Object(keywords);
                            }
                            if c.lost_keyword_mask() != 0 { v["phaseLostKeywords"] = json!(crate::ability_ir::CORE_KEYWORDS.iter().enumerate().filter_map(|(i,k)| (c.lost_keyword_mask() & (1 << i) != 0).then_some(*k)).collect::<Vec<_>>()); }
                            v["exhausted"] = json!(c.exhausted);
                            v["power"] = json!(self.power(s, id, self.is_attacking(s, id)));
                            v["hp"] = json!(self.hp(s, id));
                            let upgrades: Vec<_> = self.upgrades(s,id).into_iter().map(|uid| {
                                let mut u=self.card_ref(s,uid);let token=self.def(s,uid).info.is("token");u["token"]=json!(token);
                                if !token {u["controller"]=json!(s.card(uid).owner.as_str());u["owner"]=json!(s.card(uid).owner.as_str());}u
                            }).collect();
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
        let mut value=json!({"round":s.round,"phase":if s.regroup{"regroup"}else{"action"},"initiative":s.initiative.as_str(),"initiativeClaimed":s.initiative_claimed,"prevPassed":s.prev_passed,"activePlayer":s.action_player.map(Seat::as_str),"actor":if s.is_action_window(){Some(s.active.as_str())}else{None},"winner":winner,"nextCardId":s.next_id-1,"players":players});
        if s.hidden_history_exact {value["hiddenHistoryVersion"]=json!(1);}
        if s.arena_order_exact {value["arenaUnitOrder"]=json!({"ground":s.arena_unit_order[0].as_slice().iter().map(|id|format!("c{}",id-1)).collect::<Vec<_>>(),"space":s.arena_unit_order[1].as_slice().iter().map(|id|format!("c{}",id-1)).collect::<Vec<_>>()});}
        value
    }
}

#[cfg(test)]
#[path = "simulator_tests.rs"]
mod tests;

pub(crate) fn program_backend(hash:&str,bytes:&[u8])->Result<usize,&'static str> {generic_runtime::generated_backend(hash,bytes)}
