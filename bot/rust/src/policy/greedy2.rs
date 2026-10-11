use super::{Policy, Rng};
use crate::cards::{CardDb, CardInfo};
use crate::protocol::{other, Action, Decide, DistShare, Distribute, Hello, PlayerView, State, UnitView};
use std::collections::{HashMap, HashSet};

/// Greedy v2: the greedy rules plus card knowledge and combat math, still one decision at a time with no lookahead.
///
/// - Reads card stats from the engine's card JSON (`cards.rs`), so it knows costs, aspects, keywords and upgrade stats.
/// - Action window: lethal attacks first, then attacks that kill a ready enemy unit, then the most expensive card it
///   can play (units first, removal only when there is something to remove, leader deploy when affordable), then
///   the remaining attacks, then claim initiative, then pass.
/// - Attack targets: base damage vs. trades (kill value, damage taken back, shields, overwhelm), sentinel aware;
///   cancels an attack that only loses its unit.
/// - Other targets: parses the prompt ("deal 3 damage", "defeat", "heal", "attach", ...) and picks kills first.
/// - Resources: keeps cheap on-aspect units, resources expensive and off-aspect cards.
/// - Damage and healing splits: kills the most valuable units it can, rest to the base; own damage to its own base.
/// - Same loop guards as greedy.
pub struct Greedy2 {
    db: &'static CardDb,
    rng: Rng,
    round: u32,
    last_window_pick: Option<String>,
    /// Last own arena unit it picked: the attacker when an attack-target prompt follows.
    last_unit_pick: Option<String>,
    cancelled: HashSet<String>,
    picks: HashMap<String, u32>,
}

const MAX_REPEATS: u32 = 12;
/// Stop resourcing at this many resources.
const RESOURCE_CAP: u32 = 9;

impl Greedy2 {
    pub fn new(db: &'static CardDb) -> Self {
        if db.len() == 0 {
            eprintln!("greedy2: no card data (set SWU_CARD_JSON or run from the repo root); playing without card stats");
        }
        Greedy2 {
            db,
            rng: Rng::default(),
            round: 0,
            last_window_pick: None,
            last_unit_pick: None,
            cancelled: HashSet::new(),
            picks: HashMap::new(),
        }
    }
}

fn action_key(a: &Action) -> String {
    format!("{}:{}:{}", a.kind, a.label, a.card.as_ref().map_or("", |c| c.id.as_str()))
}

fn has_any(text: &str, words: &[&str]) -> bool {
    words.iter().any(|w| text.contains(w))
}

/// How many cards a select prompt wants, from its title ("Select 2 cards", "choose up to 3", "between 1 and 2").
pub fn wanted(title: &str) -> usize {
    let words: Vec<&str> = title.split(|c: char| !c.is_ascii_alphanumeric()).filter(|w| !w.is_empty()).collect();
    if let Some(k) = words.iter().position(|w| *w == "between") {
        if let Some(n) = words.get(k + 3).and_then(|w| w.parse().ok()) {
            return n;
        }
    }
    for (k, w) in words.iter().enumerate() {
        if *w == "select" || *w == "choose" {
            let mut j = k + 1;
            if words.get(j) == Some(&"up") && words.get(j + 1) == Some(&"to") {
                j += 2;
            }
            if let Some(n) = words.get(j).and_then(|w| w.parse().ok()) {
                return n;
            }
        }
    }
    1
}

/// "deal 3 damage" -> 3
fn damage_in(title: &str) -> Option<i32> {
    let words: Vec<&str> = title.split_whitespace().collect();
    words.windows(3).find(|w| w[0] == "deal" && w[2].starts_with("damage")).and_then(|w| w[1].parse().ok())
}

/// "-8/-0", "-2/-2": a stat penalty
fn has_debuff(text: &str) -> bool {
    text.as_bytes().windows(3).any(|w| w[0] == b'-' && w[1].is_ascii_digit() && w[2] == b'/')
}

/// What a targeting prompt does to the card picked.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Intent {
    Damage(i32),
    Remove,
    Exhaust,
    Heal,
    Help,
    Neutral,
}

const REMOVE: &[&str] = &["defeat", "capture", "return", "bounce", "take control", "discard"];
const HELP: &[&str] = &["shield", "experience", "advantage", "ready", "give", "gains", "attach", "+"];

fn intent(title: &str, source: Option<&CardInfo>) -> Intent {
    if let Some(n) = damage_in(title) {
        return Intent::Damage(n);
    }
    if title.contains("attach") {
        // upgrades that hurt (negative stats) or carry a bounty go on enemy units
        if let Some(c) = source.filter(|c| c.is("upgrade")) {
            let bad = c.upgrade_power.unwrap_or(0) < 0 || c.upgrade_hp.unwrap_or(0) < 0 || c.text_lower().contains("bounty");
            return if bad { Intent::Remove } else { Intent::Help };
        }
        return Intent::Help;
    }
    if has_any(title, REMOVE) || has_debuff(title) {
        return Intent::Remove;
    }
    if title.contains("exhaust") {
        return Intent::Exhaust;
    }
    if title.contains("heal") {
        return Intent::Heal;
    }
    if has_any(title, HELP) {
        return Intent::Help;
    }
    Intent::Neutral
}

pub fn unit_value(u: &UnitView) -> f64 {
    let mut v = u.p.max(0) as f64 * 1.3 + u.hp_left() as f64 * 0.9 + u.shields() as f64 * 2.0;
    if u.sentinel() {
        v += 1.0;
    }
    v
}

/// Extra cost for aspect icons the leader and base don't cover: 2 per missing icon.
fn aspect_penalty(card: &CardInfo, have: &[String]) -> i32 {
    let mut pool: Vec<&str> = have.iter().map(String::as_str).collect();
    let mut missing = 0;
    for a in card.aspects() {
        match pool.iter().position(|x| *x == a.as_str()) {
            Some(k) => {
                pool.swap_remove(k);
            }
            None => missing += 1,
        }
    }
    missing * 2
}

/// Everything a decision needs, from this seat.
struct Ctx<'a> {
    db: &'static CardDb,
    me: &'a str,
    state: &'a State,
    my: &'a PlayerView,
    op: &'a PlayerView,
    aspects: Vec<String>,
    /// Hand cards in the best use of this window's ready resources (action windows only).
    spend: HashSet<String>,
}

impl<'a> Ctx<'a> {
    fn card(&self, a: &Action) -> Option<&'static CardInfo> {
        let c = a.card.as_ref();
        self.db.find(Some(a.label.as_str()), c.and_then(|c| c.s.as_deref()), c.and_then(|c| c.n.as_deref()))
    }

    fn unit_info(&self, u: &UnitView) -> Option<&'static CardInfo> {
        self.db.find(None, u.s.as_deref(), u.n.as_deref())
    }

    /// The opponent's units could take this much off our base next round.
    fn in_danger(&self) -> bool {
        let threat: i32 = self.op.units().map(|u| u.p.max(0)).sum();
        threat >= self.my.base_left() - 2
    }

    fn base_weight(&self) -> f64 {
        if self.op.base_left() <= 10 { 1.7 } else { 1.2 }
    }

    fn arena_of(&self, seat_units: &PlayerView, id: &str) -> Option<&'static str> {
        if seat_units.ground.iter().any(|u| u.id == id) {
            Some("ground")
        } else if seat_units.space.iter().any(|u| u.id == id) {
            Some("space")
        } else {
            None
        }
    }

    fn enemies_in(&self, arena: &str) -> &'a [UnitView] {
        if arena == "space" { &self.op.space } else { &self.op.ground }
    }

    fn has_saboteur(&self, u: &UnitView) -> bool {
        self.unit_info(u).is_some_and(|c| c.has_keyword("saboteur"))
    }

    /// Value of `a` attacking the opponent's base.
    fn attack_base(&self, a: &UnitView) -> f64 {
        let pa = a.p.max(0);
        if pa > 0 && pa >= self.op.base_left() {
            return 1000.0;
        }
        pa as f64 * self.base_weight()
    }

    /// Value of `a` attacking enemy unit `t`: what the trade gains minus what it costs.
    fn attack_unit(&self, a: &UnitView, t: &UnitView) -> f64 {
        let pa = a.p.max(0);
        let dmg_t = if t.shields() > 0 { 0 } else { pa };
        let kills = dmg_t >= t.hp_left();
        let dmg_a = if a.shields() > 0 { 0 } else { t.p.max(0) };
        let dies = dmg_a >= a.hp_left();
        let mut gain = if kills {
            unit_value(t) + 2.0 + if t.ready() { 3.0 } else { 0.0 }
        } else {
            dmg_t as f64 * 0.35 + if t.shields() > 0 { 1.5 } else { 0.0 }
        };
        if kills && self.unit_info(a).is_some_and(|c| c.has_keyword("overwhelm")) {
            gain += (pa - t.hp_left()).max(0) as f64 * self.base_weight();
        }
        if self.in_danger() {
            gain *= 1.4;
        }
        let loss = if dies { unit_value(a) } else { dmg_a as f64 * 0.3 };
        gain - loss
    }

    /// Best attack open to own unit `a` (sentinels respected), and whether it kills a ready enemy unit.
    fn best_attack(&self, a: &UnitView) -> (f64, bool) {
        let Some(arena) = self.arena_of(self.my, &a.id) else { return (0.0, false) };
        let enemies = self.enemies_in(arena);
        let sentinel = !self.has_saboteur(a) && enemies.iter().any(|u| u.sentinel());
        let mut best = if sentinel { f64::NEG_INFINITY } else { self.attack_base(a) };
        let mut kills_ready = false;
        for t in enemies.iter().filter(|t| !sentinel || t.sentinel()) {
            let v = self.attack_unit(a, t);
            if v > best {
                best = v;
                kills_ready = t.ready() && t.shields() == 0 && a.p >= t.hp_left();
            }
        }
        (if best.is_finite() { best } else { 0.0 }, kills_ready)
    }

    /// Ready power that can reach the opponent's base this turn (arenas without an enemy sentinel).
    fn lethal_on_board(&self) -> bool {
        let reach = |units: &[UnitView], enemies: &[UnitView]| -> i32 {
            units.iter().filter(|u| u.ready() && (self.has_saboteur(u) || !enemies.iter().any(|e| e.sentinel()))).map(|u| u.p.max(0)).sum()
        };
        let power = reach(&self.my.ground, &self.op.ground) + reach(&self.my.space, &self.op.space);
        power > 0 && power >= self.op.base_left()
    }

    /// How much it wants to keep a hand card rather than resource it (higher = keep).
    fn keep_score(&self, c: Option<&CardInfo>) -> f64 {
        let Some(c) = c else { return 0.0 };
        let pen = aspect_penalty(c, &self.aspects);
        let eff = c.cost() + pen;
        let total = self.my.res.total as i32;
        let mut k = 0.0;
        if c.is("unit") {
            k += 1.5;
        }
        if eff <= total + 2 {
            k += 1.5;
        }
        if eff > total + 4 {
            k -= 1.5;
        }
        k - pen as f64 - c.cost() as f64 * 0.2
    }

    /// Priority of playing a hand (or resource, via Smuggle) card in the action window.
    fn play_score(&self, c: Option<&CardInfo>) -> f64 {
        let Some(c) = c else { return 20.0 };
        let cost = c.cost() as f64;
        if c.is("unit") {
            return 22.0 + cost * 2.0;
        }
        if c.is("upgrade") {
            return if self.my.units().next().is_some() { 18.0 + cost * 1.5 } else { 1.0 };
        }
        let text = c.text_lower();
        let removal = has_any(&text, &["defeat a", "defeat an", "deal ", "capture", "return a", "return an", "exhaust a"]) || has_debuff(&text);
        if removal && self.op.units().next().is_none() && !text.contains("base") {
            return 1.0; // hold removal until there is something to remove
        }
        17.0 + cost * 1.5
    }

    /// Playable hand cards whose total effective cost uses the most of the ready resources (units break ties).
    /// Cards it would hold anyway (removal with no target) are left out.
    fn best_spend(&self, actions: &[Action]) -> HashSet<String> {
        let mut cands: Vec<(String, i32, f64)> = Vec::new();
        for a in actions {
            let Some(c) = a.card.as_ref().filter(|c| c.zone.as_deref() == Some("hand") && c.ctl.as_deref() == Some(self.me)) else { continue };
            let Some(info) = self.card(a) else { continue };
            if self.play_score(Some(info)) < 5.0 {
                continue;
            }
            let eff = info.cost() + aspect_penalty(info, &self.aspects);
            cands.push((c.id.clone(), eff, eff as f64 + if info.is("unit") { 0.5 } else { 0.0 }));
        }
        cands.truncate(14);
        let budget = self.my.res.ready as i32;
        let (mut best, mut best_mask) = (0.0, 0u32);
        for mask in 1u32..(1 << cands.len()) {
            let (mut cost, mut val) = (0, 0.0);
            for (k, c) in cands.iter().enumerate() {
                if mask & (1 << k) != 0 {
                    cost += c.1;
                    val += c.2;
                }
            }
            if cost <= budget && val > best {
                best = val;
                best_mask = mask;
            }
        }
        cands.iter().enumerate().filter(|(k, _)| best_mask & (1 << k) != 0).map(|(_, c)| c.0.clone()).collect()
    }

    fn is_my_leader(&self, id: &str) -> bool {
        self.my.leader.as_ref().is_some_and(|l| l.id == id)
    }

    fn leader_deploy_ready(&self) -> bool {
        let Some(l) = self.my.leader.as_ref() else { return false };
        if l.dep == 1 {
            return false;
        }
        let cost = self.db.find(None, l.s.as_deref(), l.n.as_deref()).and_then(|c| c.cost).unwrap_or(99);
        self.my.res.total as i32 >= cost
    }

    fn window_card_score(&self, a: &Action) -> f64 {
        let Some(c) = a.card.as_ref() else { return 0.0 };
        let zone = c.zone.as_deref().unwrap_or("");
        match zone {
            "hand" => {
                let s = self.play_score(self.card(a));
                if self.spend.is_empty() || s < 5.0 {
                    s
                } else if self.spend.contains(&c.id) {
                    s + 8.0
                } else {
                    s - 8.0
                }
            }
            "resource" => self.play_score(self.card(a)) - 4.0,
            "groundArena" | "spaceArena" => {
                let Some(u) = self.state.unit(&c.id).filter(|_| c.ctl.as_deref() == Some(self.me)) else { return 3.0 };
                if !u.ready() {
                    return 4.0; // an exhausted unit's action ability
                }
                if self.lethal_on_board() {
                    return 200.0 + u.p as f64;
                }
                let (v, kills_ready) = self.best_attack(u);
                if kills_ready && v > 0.0 {
                    50.0 + v
                } else if v < -3.0 {
                    -1.0 // every target only costs it the unit
                } else {
                    12.0 + v
                }
            }
            _ if self.is_my_leader(&c.id) => {
                // deploying costs nothing and the leader arrives ready: do it first
                if self.leader_deploy_ready() { 60.0 } else { 6.0 }
            }
            "base" => 5.0,
            _ => 10.0,
        }
    }

    fn target_score(&self, a: &Action, title: &str, source: Option<&CardInfo>) -> f64 {
        let Some(c) = a.card.as_ref() else { return 0.0 };
        let mine = c.ctl.as_deref() == Some(self.me);
        let zone = c.zone.as_deref().unwrap_or("");
        let it = intent(title, source);
        if zone == "hand" || zone == "discard" || zone == "deck" || zone == "resource" {
            let v = self.keep_score(self.card(a)) + self.card(a).map_or(0.0, |c| c.cost() as f64 * 0.3);
            // discarding or bouncing own cards: give up the least useful one
            return if mine && it == Intent::Remove { -v } else { v };
        }
        if let Some(owner) = self.state.base_owner(&c.id) {
            let mine = owner == self.me;
            return match (it, mine) {
                (Intent::Damage(n), false) => {
                    if n >= self.op.base_left() { 1000.0 } else { n as f64 * self.base_weight() }
                }
                (Intent::Damage(n), true) => -2.0 * n as f64,
                (Intent::Heal, true) => self.my.base.d.min(5) as f64 * 0.8,
                (Intent::Remove | Intent::Exhaust, false) => 2.0,
                (Intent::Help | Intent::Heal, false) => -5.0,
                (_, true) => -3.0,
                (Intent::Neutral, false) => 0.0,
            };
        }
        let Some(u) = self.state.unit(&c.id) else { return if mine { 0.5 } else { 0.3 } };
        let val = unit_value(u);
        match (it, mine) {
            (Intent::Damage(n), false) => {
                if u.shields() > 0 {
                    1.5
                } else if n >= u.hp_left() {
                    val + 3.0 + if u.ready() { 2.0 } else { 0.0 }
                } else {
                    n as f64 * 0.4
                }
            }
            (Intent::Remove, false) => val + if u.ready() { 1.0 } else { 0.0 },
            (Intent::Exhaust, false) => {
                if u.ready() { 1.0 + val * 0.4 } else { 0.1 }
            }
            (Intent::Heal, true) => u.d.min(5) as f64 * 1.5 + val * 0.1,
            (Intent::Help, true) => val + if u.ready() { 1.0 } else { 0.0 },
            (Intent::Damage(n), true) => {
                // forced to hurt its own: pick a unit that survives, else the cheapest
                if n < u.hp_left() || u.shields() > 0 { -1.0 - n as f64 * 0.2 } else { -5.0 - val }
            }
            (Intent::Remove | Intent::Exhaust, true) => -5.0 - val,
            (Intent::Help | Intent::Heal, false) => -3.0 - val,
            (Intent::Neutral, true) => 1.0 + val * 0.1,
            (Intent::Neutral, false) => 0.5,
        }
    }

    fn attack_target_score(&self, a: &Action, attacker: Option<&UnitView>) -> f64 {
        let Some(c) = a.card.as_ref() else { return 0.0 };
        let Some(att) = attacker else {
            // unknown attacker: face first, else the weakest enemy unit
            return if self.state.base_owner(&c.id).is_some_and(|o| o != self.me) {
                9.0
            } else {
                self.state.unit(&c.id).map_or(0.0, |u| 5.0 - u.hp_left() as f64 * 0.5)
            };
        };
        if let Some(owner) = self.state.base_owner(&c.id) {
            return if owner == self.me { -100.0 } else { self.attack_base(att) };
        }
        match self.state.unit_at(&c.id) {
            Some((seat, _, t)) if seat != self.me => self.attack_unit(att, t),
            Some(_) => -100.0,
            None => 0.0,
        }
    }

    fn button_score(&self, label: &str, title: &str) -> f64 {
        let l = label.to_lowercase();
        if title.contains("no effect") {
            return if l.contains("cancel") { 5.0 } else { -5.0 };
        }
        match l.as_str() {
            "keep" => 5.0,
            "mulligan" => 0.0,
            "claim initiative" => {
                if self.state.initiative.as_deref() == Some(self.me) { -5.0 } else { 1.0 }
            }
            "pass" => 0.0,
            "skip resourcing" => -1.0,
            "yourself" if title.contains("initiative") => 5.0,
            "opponent's deck" => 1.5,
            "your deck" => 0.5,
            _ if l.contains("deploy") => 6.0,
            _ if l.contains("credit") && !l.contains("without") => 3.0,
            _ if l.contains("yourself") || l.contains("trigger") || l.starts_with("use") || l.contains("yes") || l.starts_with("play") => 4.0,
            _ if l.contains("done") || l.contains("confirm") || l.contains("resolve") || l == "ok" || l.contains("continue") => 2.0,
            _ if l.contains("pass") || l.starts_with("no") || l.contains("decline") || l.contains("skip") || l.contains("choose nothing") || l.contains("cancel") || l.contains("take nothing") => -2.0,
            _ => 1.0,
        }
    }

    fn display_score(&self, a: &Action) -> f64 {
        match self.db.by_name(&a.label) {
            Some(c) => 3.0 + c.cost() as f64 + if c.is("unit") { 1.0 } else { 0.0 },
            None => 2.0,
        }
    }

    fn score(&self, req: &Decide, a: &Action, attacker: Option<&UnitView>) -> f64 {
        let p = &req.prompt;
        let title = p.title.as_deref().unwrap_or("").to_lowercase();
        match a.kind.as_str() {
            "button" => self.button_score(&a.label, &title),
            "option" => a.label.strip_prefix('#').and_then(|n| n.parse::<f64>().ok()).map_or(1.0, |n| 1.0 + n * 0.1),
            "displayCard" => self.display_score(a),
            "card" => {
                let both = format!("{} {}", title, p.prompt_title.as_deref().unwrap_or("").to_lowercase());
                if p.select_card_mode.as_deref() == Some("multiple") && p.selected.len() >= wanted(&both) {
                    return -5.0;
                }
                if p.kind.as_deref() == Some("resource") {
                    if self.my.res.total >= RESOURCE_CAP {
                        return -2.0;
                    }
                    return 10.0 - self.keep_score(self.card(a));
                }
                if p.action_window {
                    return self.window_card_score(a);
                }
                if title.contains("target for attack") {
                    return self.attack_target_score(a, attacker);
                }
                let source = p.prompt_title.as_deref().and_then(|t| self.db.by_title(t));
                self.target_score(a, &title, source)
            }
            _ => 1.0,
        }
    }

    /// The attacker in an attack-target prompt: the own unit picked last, else the own unit named in the prompt.
    fn attacker(&self, req: &Decide, last: Option<&str>) -> Option<&'a UnitView> {
        let named = req.prompt.prompt_title.as_deref();
        if let Some(u) = last.and_then(|id| self.my.units().find(|u| u.id == id)) {
            if named.is_none() || u.n.as_deref() == named {
                return Some(u);
            }
        }
        named.and_then(|n| self.my.units().find(|u| u.n.as_deref() == Some(n)))
    }

    /// Damage: kill the most valuable enemy units it can, rest to the enemy base, then spread without killing.
    /// Own damage (indirect): own base first. Healing: most damaged own cards first.
    fn split(&self, d: &Distribute) -> Option<Vec<DistShare>> {
        #[derive(Clone, Copy)]
        enum T<'u> {
            MyUnit(&'u UnitView),
            OpUnit(&'u UnitView),
            MyBase,
            OpBase,
            Other,
        }
        let heal = d.kind.to_lowercase().contains("heal");
        let targets: Vec<(usize, T, u32)> = d
            .targets
            .iter()
            .enumerate()
            .map(|(k, t)| {
                let cap = t.cap.unwrap_or(u32::MAX);
                let kind = if let Some(o) = self.state.base_owner(&t.id) {
                    if o == self.me { T::MyBase } else { T::OpBase }
                } else if let Some((seat, _, u)) = self.state.unit_at(&t.id) {
                    if seat == self.me { T::MyUnit(u) } else { T::OpUnit(u) }
                } else {
                    T::Other
                };
                (k, kind, cap)
            })
            .collect();
        let mut amounts = vec![0u32; d.targets.len()];
        let mut left = d.amount;
        let max_t = d.max_targets.map(|m| m as usize).filter(|m| *m > 0).unwrap_or(usize::MAX);
        let used = |amounts: &Vec<u32>| amounts.iter().filter(|x| **x > 0).count();
        let give = |amounts: &mut Vec<u32>, left: &mut u32, k: usize, cap: u32, want: u32| {
            if *left == 0 || (amounts[k] == 0 && used(amounts) >= max_t) {
                return;
            }
            let n = want.min(*left).min(cap.saturating_sub(amounts[k]));
            amounts[k] += n;
            *left -= n;
        };
        let mut order: Vec<(usize, T, u32)> = targets.clone();
        if heal {
            let dmg = |t: &T| match t {
                T::MyUnit(u) => u.d as u32,
                T::MyBase => self.my.base.d as u32,
                _ => 0,
            };
            order.sort_by_key(|(_, t, _)| std::cmp::Reverse(dmg(t)));
            for &(k, t, cap) in &order {
                give(&mut amounts, &mut left, k, cap, dmg(&t));
            }
            for &(k, t, cap) in &order {
                if matches!(t, T::MyUnit(_) | T::MyBase) {
                    give(&mut amounts, &mut left, k, cap, u32::MAX);
                }
            }
        } else {
            // kills, most valuable first
            let mut kills: Vec<(usize, &UnitView, u32)> = order
                .iter()
                .filter_map(|&(k, t, cap)| if let T::OpUnit(u) = t { Some((k, u, cap)) } else { None })
                .filter(|(_, u, _)| u.shields() == 0)
                .collect();
            kills.sort_by(|a, b| unit_value(b.1).partial_cmp(&unit_value(a.1)).unwrap_or(std::cmp::Ordering::Equal));
            for &(k, u, cap) in &kills {
                let need = u.hp_left().max(1) as u32;
                if need <= left && need <= cap {
                    give(&mut amounts, &mut left, k, cap, need);
                }
            }
            for &(k, t, cap) in &order {
                if matches!(t, T::OpBase) {
                    give(&mut amounts, &mut left, k, cap, u32::MAX);
                }
            }
            // enemy units already hit, then any enemy unit (shields first: one point pops a shield)
            order.sort_by_key(|(_, t, _)| match t {
                T::OpUnit(u) if u.shields() > 0 => 0,
                T::OpUnit(_) => 1,
                T::MyBase => 2,
                T::Other => 3,
                T::MyUnit(_) => 4,
                T::OpBase => 5,
            });
            for &(k, t, cap) in &order {
                match t {
                    T::OpUnit(_) | T::MyBase | T::Other => give(&mut amounts, &mut left, k, cap, u32::MAX),
                    T::MyUnit(u) => give(&mut amounts, &mut left, k, cap, (u.hp_left() - 1).max(0) as u32),
                    T::OpBase => {}
                }
            }
        }
        // whatever is left goes anywhere it fits
        for &(k, _, cap) in &targets {
            give(&mut amounts, &mut left, k, cap, u32::MAX);
        }
        if left > 0 && !d.can_distribute_less {
            return None;
        }
        if amounts.iter().all(|x| *x == 0) && !d.can_choose_no_targets {
            return None;
        }
        Some(d.targets.iter().zip(amounts).filter(|(_, n)| *n > 0).map(|(t, n)| DistShare { id: t.id.clone(), amount: n }).collect())
    }
}

impl Greedy2 {
    fn ctx<'a>(&self, req: &'a Decide, empty: &'a PlayerView) -> Ctx<'a> {
        let me = req.you.as_str();
        let my = req.state.players.get(me).unwrap_or(empty);
        let op = req.state.players.get(other(me)).unwrap_or(empty);
        let mut aspects = Vec::new();
        if let Some(l) = my.leader.as_ref() {
            if let Some(c) = self.db.find(None, l.s.as_deref(), l.n.as_deref()) {
                aspects.extend(c.aspects().iter().cloned());
            }
        }
        if let Some(c) = self.db.find(None, my.base.s.as_deref(), my.base.n.as_deref()) {
            aspects.extend(c.aspects().iter().cloned());
        }
        let mut cx = Ctx { db: self.db, me, state: &req.state, my, op, aspects, spend: HashSet::new() };
        if req.prompt.action_window {
            cx.spend = cx.best_spend(&req.actions);
        }
        cx
    }
}

impl Policy for Greedy2 {
    fn new_game(&mut self, hello: &Hello) {
        self.rng.seed(hello.seed);
        self.round = 0;
        self.last_window_pick = None;
        self.last_unit_pick = None;
        self.cancelled.clear();
        self.picks.clear();
    }

    fn choose(&mut self, req: &Decide) -> usize {
        let p = &req.prompt;
        if req.state.round != self.round {
            self.round = req.state.round;
            self.cancelled.clear();
            self.picks.clear();
        }
        let empty = PlayerView::default();
        let cx = self.ctx(req, &empty);
        let attacker = cx.attacker(req, self.last_unit_pick.as_deref());
        let prompt_key = format!("{}|{}|{}", p.signature, p.title.as_deref().unwrap_or(""), p.selected.len());
        let n = req.actions.len();
        let start = self.rng.below(n);
        let mut best = start;
        let mut best_score = f64::NEG_INFINITY;
        for k in 0..n {
            let i = (start + k) % n;
            let a = &req.actions[i];
            let key = action_key(a);
            let mut s = cx.score(req, a, attacker);
            if p.action_window && self.cancelled.contains(&key) {
                s -= 50.0;
            }
            if self.picks.get(&format!("{prompt_key}|{key}")).copied().unwrap_or(0) >= MAX_REPEATS {
                s -= 100.0;
            }
            if s > best_score {
                best_score = s;
                best = i;
            }
        }
        let chosen = &req.actions[best];
        let key = action_key(chosen);
        if let Some(c) = chosen.card.as_ref() {
            if c.ctl.as_deref() == Some(cx.me) && cx.my.units().any(|u| u.id == c.id) {
                self.last_unit_pick = Some(c.id.clone());
            }
        }
        if p.action_window {
            self.last_window_pick = Some(key.clone());
        } else if chosen.kind == "button" && chosen.label.eq_ignore_ascii_case("cancel") {
            if let Some(pick) = self.last_window_pick.take() {
                self.cancelled.insert(pick);
            }
        }
        *self.picks.entry(format!("{prompt_key}|{key}")).or_insert(0) += 1;
        best
    }

    fn distribution(&mut self, req: &Decide, i: usize) -> Option<Vec<DistShare>> {
        let d = req.actions.get(i)?.distribute.as_ref()?;
        let empty = PlayerView::default();
        self.ctx(req, &empty).split(d)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cards::test_card;

    fn db() -> &'static CardDb {
        let mut db = CardDb::default();
        db.insert(test_card("wampa", r#"{"title":"Wampa","cost":4,"power":4,"hp":5,"aspects":["aggression"],"types":["unit"],"setId":{"set":"SOR","number":38}}"#));
        db.insert(test_card("cheap-guy", r#"{"title":"Cheap Guy","cost":1,"power":1,"hp":2,"aspects":["villainy"],"types":["unit"]}"#));
        db.insert(test_card("big-ship", r#"{"title":"Big Ship","cost":8,"power":8,"hp":8,"aspects":["heroism","heroism"],"types":["unit"]}"#));
        db.insert(test_card("takedown", r#"{"title":"Takedown","cost":4,"text":"Defeat a unit with 5 or less remaining HP.","types":["event"]}"#));
        db.insert(test_card("vader", r#"{"title":"Darth Vader","cost":7,"aspects":["aggression","villainy"],"types":["leader"],"setId":{"set":"SOR","number":10}}"#));
        db.insert(test_card("outpost", r#"{"title":"Outpost","aspects":["vigilance"],"types":["base"],"setId":{"set":"LAW","number":19}}"#));
        Box::leak(Box::new(db))
    }

    fn req(prompt: &str, state: &str, actions: &str) -> Decide {
        serde_json::from_str(&format!(r#"{{"t":"decide","seq":1,"you":"p1","prompt":{prompt},"state":{state},"actions":{actions}}}"#)).unwrap()
    }

    const WINDOW: &str = r#"{"type":"actionWindow","signature":"actionWindow|-","title":"Choose an action","promptTitle":"Action Window","selectCardMode":null,"selected":[],"actionWindow":true}"#;
    const ATTACK: &str = r#"{"type":null,"signature":"-|single","title":"Choose a target for attack","promptTitle":"Rebel","selectCardMode":"single","selected":[],"actionWindow":false}"#;

    fn state(my_units: &str, op_units: &str, op_base_d: i32) -> String {
        format!(
            r#"{{"round":3,"phase":"action","initiative":"p2","players":{{
              "p1":{{"base":{{"id":"b1","s":"LAW_019","hp":26,"d":0}},"leader":{{"id":"l1","s":"SOR_010","dep":0,"x":0}},"res":{{"ready":4,"total":4}},"ground":{my_units}}},
              "p2":{{"base":{{"id":"b2","hp":26,"d":{op_base_d}}},"ground":{op_units}}}}}}}"#
        )
    }

    fn pick(r: &Decide) -> usize {
        let mut g = Greedy2::new(db());
        g.new_game(&serde_json::from_str(r#"{"t":"hello","v":1,"you":"p1","seed":7}"#).unwrap());
        g.choose(r)
    }

    #[test]
    fn plays_the_biggest_card_and_holds_removal_with_no_targets() {
        let acts = r#"[{"i":0,"kind":"button","label":"Pass"},{"i":1,"kind":"card","label":"cheap-guy","card":{"id":"h1","zone":"hand","ctl":"p1"}},
                       {"i":2,"kind":"card","label":"wampa","card":{"id":"h2","zone":"hand","ctl":"p1"}},{"i":3,"kind":"card","label":"takedown","card":{"id":"h3","zone":"hand","ctl":"p1"}}]"#;
        assert_eq!(pick(&req(WINDOW, &state("[]", "[]", 0), acts)), 2);
    }

    #[test]
    fn spends_resources_fully() {
        // 5 ready: wampa (4) alone wastes 1; cheap-guy (1) + wampa (4) uses all 5, so the plan holds both
        let acts = r#"[{"i":0,"kind":"button","label":"Pass"},{"i":1,"kind":"card","label":"cheap-guy","card":{"id":"h1","zone":"hand","ctl":"p1"}},
                       {"i":2,"kind":"card","label":"wampa","card":{"id":"h2","zone":"hand","ctl":"p1"}}]"#;
        let st = state("[]", "[]", 0).replace(r#""ready":4,"total":4"#, r#""ready":5,"total":5"#);
        let r = req(WINDOW, &st, acts);
        let g = Greedy2::new(db());
        let empty = PlayerView::default();
        let cx = g.ctx(&r, &empty);
        assert_eq!(cx.spend.len(), 2);
        assert_eq!(pick(&r), 2);
    }

    #[test]
    fn attacks_for_lethal_before_playing() {
        let st = state(r#"[{"id":"u1","n":"Rebel","p":3,"h":3,"d":0}]"#, "[]", 24);
        let acts = r#"[{"i":0,"kind":"button","label":"Pass"},{"i":1,"kind":"card","label":"wampa","card":{"id":"h2","zone":"hand","ctl":"p1"}},
                       {"i":2,"kind":"card","label":"rebel","card":{"id":"u1","zone":"groundArena","ctl":"p1"}}]"#;
        assert_eq!(pick(&req(WINDOW, &st, acts)), 2);
    }

    #[test]
    fn takes_a_free_kill_but_not_a_suicide_attack() {
        let acts = r#"[{"i":0,"kind":"button","label":"Cancel"},{"i":1,"kind":"card","label":"base","card":{"id":"b2","zone":"base","ctl":"p2"}},
                       {"i":2,"kind":"card","label":"x","card":{"id":"e1","zone":"groundArena","ctl":"p2"}}]"#;
        let me = r#"[{"id":"u1","n":"Rebel","p":3,"h":4,"d":0,"x":1}]"#;
        // 3 power kills a 2/2 that hits back for 2: trade up
        assert_eq!(pick(&req(ATTACK, &state(me, r#"[{"id":"e1","n":"Guy","p":2,"h":2,"d":0}]"#, 0), acts)), 2);
        // a 6/7 would kill it and survive: go face
        assert_eq!(pick(&req(ATTACK, &state(me, r#"[{"id":"e1","n":"Guy","p":6,"h":7,"d":0}]"#, 0), acts)), 1);
    }

    #[test]
    fn resources_expensive_off_aspect_cards_first() {
        let prompt = r#"{"type":"resource","signature":"resource|multiple","title":"Select 2 cards to resource","promptTitle":"Resource Step","selectCardMode":"multiple","selected":[],"actionWindow":false}"#;
        let acts = r#"[{"i":0,"kind":"card","label":"cheap-guy","card":{"id":"h1","zone":"hand","ctl":"p1"}},{"i":1,"kind":"card","label":"big-ship","card":{"id":"h2","zone":"hand","ctl":"p1"}},
                       {"i":2,"kind":"card","label":"wampa","card":{"id":"h3","zone":"hand","ctl":"p1"}}]"#;
        assert_eq!(pick(&req(prompt, &state("[]", "[]", 0), acts)), 1);
    }

    #[test]
    fn damage_event_goes_for_the_kill() {
        let prompt = r#"{"type":null,"signature":"-|single","title":"Deal 3 damage to a unit","promptTitle":"Zap","selectCardMode":"single","selected":[],"actionWindow":false}"#;
        let st = state("[]", r#"[{"id":"e1","n":"Big","p":6,"h":7,"d":0},{"id":"e2","n":"Mid","p":3,"h":3,"d":0}]"#, 0);
        let acts = r#"[{"i":0,"kind":"card","label":"big","card":{"id":"e1","zone":"groundArena","ctl":"p2"}},{"i":1,"kind":"card","label":"mid","card":{"id":"e2","zone":"groundArena","ctl":"p2"}}]"#;
        assert_eq!(pick(&req(prompt, &st, acts)), 1);
    }

    #[test]
    fn cancels_a_play_that_has_no_effect() {
        let prompt = r#"{"type":null,"signature":"-|-","title":"Playing Zap will have no effect. Are you sure you want to play it?","promptTitle":"Framework effect","selectCardMode":null,"selected":[],"actionWindow":false}"#;
        let acts = r#"[{"i":0,"kind":"button","label":"Play anyway"},{"i":1,"kind":"button","label":"Cancel"}]"#;
        assert_eq!(pick(&req(prompt, &state("[]", "[]", 0), acts)), 1);
    }

    #[test]
    fn splits_damage_to_kill_then_face() {
        let st: State = serde_json::from_str(&state("[]", r#"[{"id":"e1","n":"A","p":2,"h":2,"d":0},{"id":"e2","n":"B","p":5,"h":6,"d":0}]"#, 0)).unwrap();
        let r = Decide { seq: 1, you: "p1".into(), prompt: Default::default(), state: st, actions: vec![] };
        let g = Greedy2::new(db());
        let empty = PlayerView::default();
        let d: Distribute = serde_json::from_str(r#"{"type":"distributeDamage","amount":5,"targets":[{"id":"e1","cap":null},{"id":"e2","cap":null},{"id":"b2","cap":null}]}"#).unwrap();
        let s = g.ctx(&r, &empty).split(&d).unwrap();
        assert_eq!(s, vec![DistShare { id: "e1".into(), amount: 2 }, DistShare { id: "b2".into(), amount: 3 }]);
        // indirect damage on its own side lands on its base
        let d: Distribute = serde_json::from_str(r#"{"type":"distributeIndirectDamage","amount":3,"targets":[{"id":"u9","cap":2},{"id":"b1","cap":null}]}"#).unwrap();
        assert_eq!(g.ctx(&r, &empty).split(&d).unwrap(), vec![DistShare { id: "b1".into(), amount: 3 }]);
    }

    #[test]
    fn aspect_penalty_counts_each_missing_icon() {
        let d = db();
        let have = vec!["heroism".to_string(), "vigilance".to_string()];
        assert_eq!(aspect_penalty(d.by_name("big-ship").unwrap(), &have), 2);
        assert_eq!(aspect_penalty(d.by_name("wampa").unwrap(), &have), 2);
    }

    #[test]
    fn parses_damage_amounts() {
        assert_eq!(damage_in("deal 3 damage to a unit"), Some(3));
        assert_eq!(damage_in("choose units to deal 1 damage to"), Some(1));
        assert_eq!(damage_in("defeat a unit"), None);
    }
}
