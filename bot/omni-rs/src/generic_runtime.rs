//! Interpreter for the bounded, data-only card IR. No TypeScript runs in search.
use super::*;
use crate::ability_ir::{Cost, Effect, Expr, Instruction, Program, Target, TargetResolver};

#[derive(Clone, Debug, PartialEq)]
enum Eval {
    Array(Vec<Eval>),
    Number(i64),
    Bool(bool),
    Text(String),
    Card(CardId),
    Player(Seat),
    Null,
}
impl Eval {
    fn number(&self) -> i64 {
        match self {
            Self::Number(n) => *n,
            Self::Bool(b) => i64::from(*b),
            _ => 0,
        }
    }
    fn truth(&self) -> bool {
        match self {
            Self::Null => false,
            Self::Bool(b) => *b,
            Self::Number(n) => *n != 0,
            Self::Text(t) => !t.is_empty(),
            _ => true,
        }
    }
}
enum GroupOp<'a> {
    Leaf(&'a Effect),
    Select(&'a TargetResolver, &'a Effect, usize),
    Pop,
    Branch(&'a Expr, usize),
    Jump(usize),
}
fn group_ops(effect: &Effect) -> Vec<GroupOp<'_>> {
    fn add<'a>(e: &'a Effect, out: &mut Vec<GroupOp<'a>>) {
        match e {
            Effect::Simultaneous { effects } | Effect::PhaseModifiers { effects } => { for e in effects { add(e,out); } }
            Effect::Select { target_resolver, effect } => {
                let index=out.len(); out.push(GroupOp::Select(target_resolver,effect,0));
                add(effect,out); out.push(GroupOp::Pop);
                let end=out.len(); out[index]=GroupOp::Select(target_resolver,effect,end);
            }
            Effect::Conditional { condition,on_true,on_false } => {
                let branch=out.len(); out.push(GroupOp::Branch(condition,0)); add(on_true,out);
                let jump=out.len(); out.push(GroupOp::Jump(0));
                let alternate=out.len(); if let Some(e)=on_false { add(e,out); }
                let end=out.len(); out[branch]=GroupOp::Branch(condition,alternate); out[jump]=GroupOp::Jump(end);
            }
            Effect::NoAction => {},
            _ => out.push(GroupOp::Leaf(e)),
        }
    }
    let mut out=vec![]; add(effect,&mut out); out
}
#[derive(Clone, Copy)]
enum Trigger {
    Keyword(u8),
    Program(usize, u16),
}

impl Engine {
    /// Load every fully executable card, retaining explicit reasons for all others.
    pub fn from_catalogue_value(value: &Value) -> Result<Self, String> {
        let mut catalogue = Catalogue::load(value)?;
        let mut definitions = Vec::new();
        let mut by_code = HashMap::new();
        let mut shield_def = None;
        let mut experience_def = None;
        for entry in value["cards"].as_array().ok_or("catalogue missing cards")? {
            let code = entry["setCode"]
                .as_str()
                .ok_or("catalogue card missing code")?
                .to_owned();
            let native_token = matches!(code.as_str(), "TOKEN_SHIELD" | "TOKEN_EXPERIENCE");
            if !native_token && !catalogue.cards.contains_key(&code) {
                continue;
            }
            let result = (|| -> Result<Definition, String> {
                let info: CardInfo =
                    serde_json::from_value(entry["card"].clone()).map_err(|e| e.to_string())?;
                for field in ["cost", "power", "hp"] {
                    let value = &entry["card"][field];
                    if !value.is_null() && !value.as_u64().is_some_and(|n| n <= 1000) {
                        return Err(format!("{field} must be an integer in 0..=1000"));
                    }
                }
                let programs = catalogue.cards.get(&code).cloned().unwrap_or_default();
                if native_token {
                    let expected_hash = if code == "TOKEN_SHIELD" {
                        "39f1c6699c36ba309a8fe8e053f9b94ddbb8877991767b6664fcd88d447be91f"
                    } else {
                        "fccf00d13061bfc15447101a0dc82fc360f9b5d2e28a9da678684e8c93bc9d67"
                    };
                    if entry["sourceHash"] != expected_hash {
                        return Err("native token source changed; adapter requires review".into());
                    }
                    let bonus = if code == "TOKEN_SHIELD" { 0 } else { 1 };
                    for field in ["power", "hp", "upgradePower", "upgradeHp"] {
                        if entry["card"][field] != bonus {
                            return Err(format!(
                                "native token {field} differs from reviewed adapter"
                            ));
                        }
                    }
                    let expected = if code == "TOKEN_SHIELD" {
                        "shield"
                    } else {
                        "experience"
                    };
                    if info.internal_name != expected || !info.is("token") || !info.is("upgrade") {
                        return Err("invalid native token metadata".into());
                    }
                } else if info.is("base") {
                    if !info.hp.is_some_and(|n| (1..=1000).contains(&n))
                        || !info.text.as_deref().unwrap_or("").trim().is_empty()
                        || !programs.card.is_empty()
                    {
                        return Err("only plain bases with bounded positive HP execute".into());
                    }
                } else if info.is("event") {
                    if programs.card.len() != 1
                        || catalogue.programs[programs.card[0] as usize].trigger != "event"
                    {
                        return Err("event needs exactly one event program".into());
                    }
                } else if !info.is("unit") && !info.is("leader") {
                    return Err("runtime card type is not implemented".into());
                }
                let mut flags = 0;
                let mut raid = 0;
                let mut restore = 0;
                for keyword in entry["card"]["keywords"].as_array().into_iter().flatten() {
                    let name = keyword.as_str().ok_or("invalid keyword")?;
                    if !crate::ability_ir::CORE_KEYWORDS.contains(&name) { return Err(format!("unimplemented runtime keyword {name}")); }
                    // Provider metadata includes keyword mentions in abilities.
                    // Only the compiler's engine-matching printed-text parse
                    // establishes an intrinsic keyword instance.
                    if entry["keywordValues"].get(name).is_none() { continue; }
                    if !["raid", "restore"].contains(&name) && entry["keywordValues"][name].as_u64() != Some(1) { return Err(format!("invalid printed boolean keyword {name}")); }

                    match name {
                        "sentinel" => flags |= SENTINEL,
                        "overwhelm" => flags |= OVERWHELM,
                        "saboteur" => flags |= SABOTEUR,
                        "ambush" => flags |= AMBUSH,
                        "grit" => flags |= GRIT,
                        "shielded" => flags |= SHIELDED,
                        "raid" | "restore" => {
                            let amount = entry["keywordValues"][name]
                                .as_u64()
                                .filter(|n| *n <= 1000)
                                .ok_or_else(|| format!("missing bounded keyword amount {name}"))?
                                as u16;
                            if name == "restore" && amount == 0 { return Err("zero printed Restore requires verified nullable trigger titles".into()); }
                            if name == "raid" {
                                flags |= 1 << 6;
                                raid = amount;
                            } else {
                                flags |= 1 << 7;
                                restore = amount;
                            }
                        }
                        _ => return Err(format!("unimplemented runtime keyword {name}")),
                    }
                }
                for side in [&programs.card, &programs.leader, &programs.unit] {
                    if side.len() > 16 {
                        return Err("card has more than 16 abilities on one side".into());
                    }
                }
                if info.is("leader") && programs.leader.iter().any(|p| catalogue.programs[*p as usize].trigger == "constant") {
                    return Err("leader-front constants require verified base-zone ongoing sources".into());
                }
                // A leader's deployment trigger requires a separate registration; never silently drop it.
                if info.is("leader")
                    && programs
                        .unit
                        .iter()
                        .any(|p| catalogue.programs[*p as usize].trigger == "whenPlayed")
                {
                    return Err("leader deployment triggers require whenDeployed semantics".into());
                }
                let mut aspects = [0; 6];
                for a in info.aspects() {
                    aspects[aspect(a)?] += 1;
                }
                if (info.is("unit") || info.is("leader"))
                    && !matches!(info.arena.as_deref(), Some("ground" | "space"))
                {
                    return Err("unit is missing arena".into());
                }
                Ok(Definition {
                    code: code.clone(),
                    info,
                    flags,
                    raid,
                    restore,
                    aspects,
                    programs,
                    traits: entry["card"]["traits"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect(),
                })
            })();
            match result {
                Ok(d) => {
                    let id = definitions.len() as u16;
                    if code == "TOKEN_SHIELD" {
                        shield_def = Some(id);
                    }
                    if code == "TOKEN_EXPERIENCE" {
                        experience_def = Some(id);
                    }
                    catalogue.rejected.remove(&code);
                    catalogue
                        .metadata
                        .insert(code.clone(), entry["card"].clone());
                    catalogue.cards.entry(code.clone()).or_default();
                    by_code.insert(code, id);
                    definitions.push(d);
                }
                Err(reason) => {
                    catalogue.cards.remove(&code);
                    catalogue.metadata.remove(&code);
                    catalogue.rejected.insert(code, reason);
                }
            }
        }
        Ok(Self {
            pool_hash: format!(
                "{:x}",
                Sha256::digest(serde_json::to_vec(value).map_err(|e| e.to_string())?)
            ),
            definitions,
            by_code,
            shield_def: shield_def.ok_or("catalogue must include native Shield token")?,
            experience_def,
            catalogue: Some(catalogue),
        })
    }
    pub fn from_catalogue_bytes(bytes: &[u8]) -> Result<Self, String> {
        Self::from_catalogue_value(&serde_json::from_slice(bytes).map_err(|e| e.to_string())?)
    }
    /// Export the admitted subset for the independent engine's pool-restricted oracle.
    pub fn compiled_pool(&self) -> Result<Value, String> {
        let catalogue = self
            .catalogue
            .as_ref()
            .ok_or("engine has no compiled catalogue")?;
        let mut codes: Vec<_> = catalogue.metadata.keys().collect();
        codes.sort();
        let cards: Vec<_> = codes
            .into_iter()
            .map(|code| {
                let mut card = catalogue.metadata[code].clone();
                card["setCode"] = json!(code);
                card
            })
            .collect();
        Ok(
            json!({"schema":"omni-rs-pool-v1","description":"Cards admitted by the bounded generated-IR runtime; admission is not differential validation.","cards":cards}),
        )
    }
    /// Bind generated programs to an independently exported pool and its exact bytes.
    pub fn from_compiled_pool_bytes(
        pool_bytes: &[u8],
        catalogue_bytes: &[u8],
    ) -> Result<Self, String> {
        let pool: Value = serde_json::from_slice(pool_bytes).map_err(|e| e.to_string())?;
        if pool["schema"] != "omni-rs-pool-v1" {
            return Err("unsupported pool schema".into());
        }
        let mut engine = Self::from_catalogue_bytes(catalogue_bytes)?;
        let catalogue = engine.catalogue.as_mut().unwrap();
        let mut included = std::collections::HashSet::new();
        for card in pool["cards"].as_array().ok_or("pool needs cards array")? {
            let code = card["setCode"]
                .as_str()
                .ok_or("pool card missing setCode")?;
            if !included.insert(code.to_owned()) {
                return Err(format!("duplicate pool card {code}"));
            }
            let approved = catalogue.metadata.get(code).ok_or_else(|| {
                format!(
                    "unsupported pool card {code}: {}",
                    catalogue
                        .rejected
                        .get(code)
                        .map(String::as_str)
                        .unwrap_or("not in compiled catalogue")
                )
            })?;
            for field in [
                "title",
                "subtitle",
                "internalName",
                "cost",
                "hp",
                "power",
                "text",
                "deployBox",
                "epicAction",
                "unique",
                "upgradePower",
                "upgradeHp",
                "aspects",
                "keywords",
                "types",
                "arena",
                "traits",
                "pilotText",
            ] {
                if card[field] != approved[field] {
                    return Err(format!(
                        "pool card {code}: {field} differs from compiled catalogue"
                    ));
                }
            }
        }
        if !included.contains("TOKEN_SHIELD") {
            return Err("pool must include TOKEN_SHIELD".into());
        }
        catalogue.metadata.retain(|code, _| included.contains(code));
        engine.pool_hash = format!("{:x}", Sha256::digest(pool_bytes));
        Ok(engine)
    }

    pub fn rejected_cards(&self) -> Option<&std::collections::BTreeMap<String, String>> {
        self.catalogue.as_ref().map(|c| &c.rejected)
    }
    pub(super) fn token_count(&self, s: &State, mut id: CardId) -> u16 {
        let mut count = 0;
        while id != 0 {
            count += 1;
            id = s.card(id).next_token;
        }
        count
    }
    pub(super) fn check_stat_capacity(&self, s: &State) -> Result<(), String> {
        for id in 1..s.next_id {
            if !self.in_arena(s, id) {
                continue;
            }
            let d = self.def(s, id);
            for keyword in ["raid", "restore"] {
                if !(0..=65535).contains(&self.raw_keyword_amount(s, id, keyword)) { return Err(format!("computed {keyword} exceeds bounded keyword capacity")); }
            }
            let (constant_power, constant_hp) = self.constant_stats(s, id);
            let power = d.info.power.unwrap_or(0) as i64
                + self.token_count(s, s.card(id).experience) as i64
                + s.card(id).phase_power as i64
                + constant_power
                + if self.keyword_amount(s, id, "grit") > 0 {
                    s.card(id).damage as i64
                } else {
                    0
                }
                + self.keyword_amount(s, id, "raid") as i64;
            let hp = d.info.hp.unwrap_or(0) as i64
                + self.token_count(s, s.card(id).experience) as i64
                + s.card(id).phase_hp as i64
                + constant_hp;
            if power > 65535 || hp > 65535 {
                return Err("computed stats exceed compact capacity".into());
            }
        }
        Ok(())
    }
    pub(super) fn sweep_stat_defeats(&self, s: &mut State) -> Result<(), String> {
        // The uniqueness prompt precedes the engine game-state resolution.
        // Even a newly entered lethal copy remains selectable until it resolves.
        if s.decision == Decision::Unique {
            return Ok(());
        }
        loop {
            self.check_stat_capacity(s)?;
            // The reference arena traverses ground cards, then space cards,
            // retaining entry order within each arena. Relative order across
            // controllers cannot affect this subset's per-player discard lists.
            let dead: Vec<_> = s
                .players
                .iter()
                .flat_map(|p| p.ground.as_slice().iter().chain(p.space.as_slice()))
                .copied()
                .filter(|&id| s.card(id).damage >= self.hp(s, id))
                .collect();
            if dead.is_empty() {
                return Ok(());
            }
            for id in dead {
                self.defeat(s, id)?;
            }
        }
    }
    fn constant_effects<'a>(&'a self, s: &State, target: CardId, keywords: bool) -> Vec<(CardId, &'a Effect)> {
        if self.catalogue.is_none() || !self.in_arena(s, target) { return vec![]; }
        let mut effects = vec![];
        for source in 1..s.next_id {
            // Incoming unique copies have not activated their ongoing abilities:
            // the engine resolves uniqueness before resolveGameState.
            if !self.in_arena(s, source)
                || source == s.disabled_ongoing_source
                || (s.decision == Decision::Unique && source == s.source)
            {
                continue;
            }
            for program in self
                .card_programs(s, source)
                .iter()
                .map(|&id| self.program(id))
            {
                if keywords && !program.instructions.iter().any(|i| matches!(i, Instruction::Apply(Effect::GainKeyword { .. } | Effect::LoseKeyword { .. }))) { continue; }
                if program.trigger != "constant"
                    || program
                        .condition
                        .as_ref()
                        .is_some_and(|c| !self.eval(s, source, target, c).truth())
                {
                    continue;
                }
                let resolver = program.instructions.iter().find_map(|i| {
                    if let Instruction::Select(r) = i {
                        Some(r)
                    } else {
                        None
                    }
                });
                if resolver.map_or(source != target, |r| {
                    !self.matching_targets(s, source, r).contains(&target)
                }) {
                    continue;
                }
                for instruction in &program.instructions {
                    if let Instruction::Apply(effect) = instruction { effects.push((source, effect)); }
                }
            }
        }
        effects
    }
    pub(super) fn constant_stats(&self, s: &State, target: CardId) -> (i64, i64) {
        let mut total = (0, 0);
        for (source, effect) in self.constant_effects(s, target, false) {
            if let Effect::ModifyStats { power, hp, .. } = effect {
                total.0 += self.eval(s, source, target, power).number();
                total.1 += self.eval(s, source, target, hp).number();
            }
        }
        total
    }
    fn raw_keyword_amount(&self, s: &State, target: CardId, keyword: &str) -> i64 {
        let Some(index) = crate::ability_ir::CORE_KEYWORDS.iter().position(|k| *k == keyword) else { return 0; };
        if s.card(target).phase_lost_keywords & (1 << index) != 0 { return 0; }
        let definition = self.def(s, target);
        let mut total = match index {
            6 => definition.raid as i64,
            7 => definition.restore as i64,
            _ => i64::from(definition.flags & (1 << index) != 0),
        } + s.card(target).phase_keyword_amount(index) as i64;
        for (source, effect) in self.constant_effects(s, target, true) {
            match effect {
                Effect::LoseKeyword { keyword: name, .. } if name == keyword => return 0,
                Effect::GainKeyword { keyword: name, amount, .. } if name == keyword => total += self.eval(s, source, target, amount).number(),
                _ => {}
            }
        }
        if index < 6 { i64::from(total > 0) } else { total }
    }
    pub(super) fn keyword_amount(&self, s: &State, target: CardId, keyword: &str) -> u16 {
        self.raw_keyword_amount(s, target, keyword).clamp(0, u16::MAX as i64) as u16
    }
    pub(super) fn has_keyword(&self, s: &State, target: CardId, keyword: &str) -> bool {
        let Some(index) = crate::ability_ir::CORE_KEYWORDS.iter().position(|k| *k == keyword) else { return false; };
        if s.card(target).phase_lost_keywords & (1 << index) != 0 { return false; }
        let effects = self.constant_effects(s, target, true);
        if effects.iter().any(|(_,e)| matches!(e, Effect::LoseKeyword {keyword: name, ..} if name == keyword)) { return false; }
        s.card(target).phase_keyword_presence & (1 << index) != 0 || (self.def(s, target).flags & (1 << index) != 0 || (index == 6 && self.def(s, target).raid > 0) || (index == 7 && self.def(s, target).restore > 0)) || effects.iter().any(|(_,e)| matches!(e, Effect::GainKeyword {keyword: name, ..} if name == keyword))
    }
    pub(super) fn effective_flags(&self, s: &State, target: CardId) -> u16 {
        crate::ability_ir::CORE_KEYWORDS[..6].iter().enumerate().fold(0, |flags, (i, k)| flags | if self.keyword_amount(s, target, k) > 0 { 1 << i } else { 0 })
    }
    pub fn hp(&self, s: &State, id: CardId) -> u16 {
        (self.def(s, id).info.hp.unwrap_or(0) as i64
            + self.token_count(s, s.card(id).experience) as i64
            + s.card(id).phase_hp as i64
            + self.constant_stats(s, id).1)
            .clamp(0, u16::MAX as i64) as u16
    }
    fn program(&self, id: u16) -> &Program {
        &self.catalogue.as_ref().expect("IR catalogue").programs[id as usize]
    }
    fn card_programs<'a>(&'a self, s: &State, id: CardId) -> &'a [u16] {
        let d = self.def(s, id);
        if d.info.is("leader") {
            if s.card(id).deployed {
                &d.programs.unit
            } else {
                &d.programs.leader
            }
        } else {
            &d.programs.card
        }
    }
    pub(super) fn available_programs(&self, s: &State, id: CardId, trigger: &str) -> Vec<u16> {
        if self.catalogue.is_none() {
            return vec![];
        }
        self.card_programs(s, id)
            .iter()
            .copied()
            .filter(|p| {
                let p = self.program(*p);
                p.trigger == trigger
                    && p.condition
                        .as_ref()
                        .is_none_or(|c| self.eval(s, id, 0, c).truth())
                    && p.costs.iter().all(|c| match c {
                        Cost::ExhaustSelf => !s.card(id).exhausted,
                        Cost::Resources { .. } => true,
                    })
                    && p.costs
                        .iter()
                        .map(|c| match c {
                            Cost::Resources { amount } => self.eval(s, id, 0, amount).number(),
                            _ => 0,
                        })
                        .sum::<i64>()
                        <= self.ready_resources(s, s.card(id).owner) as i64
            })
            .collect()
    }
    fn eval(&self, s: &State, source: CardId, target: CardId, e: &Expr) -> Eval {
        self.eval_with_card(s, source, target, target, e)
    }
    fn eval_with_card(
        &self,
        s: &State,
        source: CardId,
        target: CardId,
        card: CardId,
        e: &Expr,
    ) -> Eval {
        let player = s.card(source).owner;
        let sub = |e| self.eval_with_card(s, source, target, card, e);
        match e {
            Expr::Array { items } => Eval::Array(items.iter().map(sub).collect()),
            Expr::Math { name, args } => {
                let values: Vec<i64> = args.iter().map(|a| sub(a).number()).collect();
                Eval::Number(if name == "min" {
                    values.into_iter().min().unwrap_or(0)
                } else {
                    values.into_iter().max().unwrap_or(0)
                })
            }
            Expr::Const { value } => {
                if let Some(n) = value.as_i64() {
                    Eval::Number(n)
                } else if let Some(b) = value.as_bool() {
                    Eval::Bool(b)
                } else if let Some(t) = value.as_str() {
                    Eval::Text(t.into())
                } else {
                    Eval::Null
                }
            }
            Expr::Ref { path } => {
                let root = path.first().map(String::as_str).unwrap_or("");
                let field = path.get(1).map(String::as_str);
                if root == "event" {
                    return Eval::Number(s.ability_result as i64);
                }
                if matches!(root, "player" | "opponent") {
                    let p = if root == "player" {
                        player
                    } else {
                        player.other()
                    };
                    return match field {
                        None => Eval::Player(p),
                        Some("base") => {
                            if path.get(2).map(String::as_str) == Some("damage") {
                                Eval::Number(s.card(s.player(p).base).damage as i64)
                            } else {
                                Eval::Card(s.player(p).base)
                            }
                        }
                        Some("readyResourceCount") => {
                            Eval::Number(self.ready_resources(s, p) as i64)
                        }
                        Some("exhaustedResourceCount") => Eval::Number(
                            s.player(p).resources.len as i64 - self.ready_resources(s, p) as i64,
                        ),
                        Some("resources") => Eval::Number(s.player(p).resources.len as i64),
                        Some("hand") => Eval::Number(s.player(p).hand.len as i64),
                        Some("drawDeck") => Eval::Number(s.player(p).deck.len as i64),
                        Some("discard") => Eval::Number(s.player(p).discard.len as i64),
                        _ => Eval::Null,
                    };
                }
                let id = if root == "source" {
                    source
                } else if root == "card" {
                    card
                } else {
                    target
                };
                if id == 0 {
                    return Eval::Null;
                }
                match field {
                    None => Eval::Card(id),
                    Some("controller") => Eval::Player(s.card(id).owner),
                    Some("damage") => Eval::Number(s.card(id).damage as i64),
                    Some("power") => {
                        Eval::Number(
                            self.power(s, id, s.trigger_context == 2 && id == s.source) as i64
                        )
                    }
                    Some("hp") => Eval::Number(self.hp(s, id) as i64),
                    Some("remainingHp") => {
                        Eval::Number(self.hp(s, id).saturating_sub(s.card(id).damage) as i64)
                    }
                    Some("title") => Eval::Text(self.def(s, id).info.title.clone()),
                    Some("cost") => Eval::Number(self.def(s, id).info.cost() as i64),
                    Some("exhausted") => Eval::Bool(s.card(id).exhausted),
                    Some("zoneName") => {
                        let p = s.player(s.card(id).owner);
                        let zone = if p.ground.contains(id) {
                            "groundArena"
                        } else if p.space.contains(id) {
                            "spaceArena"
                        } else if p.hand.contains(id) {
                            "hand"
                        } else if p.discard.contains(id) {
                            "discard"
                        } else if p.resources.contains(id) {
                            "resource"
                        } else if p.deck.contains(id) {
                            "deck"
                        } else if p.base == id {
                            "base"
                        } else {
                            "leader"
                        };
                        Eval::Text(zone.into())
                    }
                    Some("unique") => Eval::Bool(self.def(s, id).info.unique),
                    _ => Eval::Null,
                }
            }
            Expr::Binary { op, left, right } => {
                let a = sub(left);
                if op == "&&" && !a.truth() {
                    return a;
                }
                if op == "||" && a.truth() {
                    return a;
                }
                let b = sub(right);
                match op.as_str() {
                    "+" => Eval::Number(a.number().saturating_add(b.number())),
                    "-" => Eval::Number(a.number().saturating_sub(b.number())),
                    "*" => Eval::Number(a.number().saturating_mul(b.number())),
                    "/" => Eval::Number(a.number().checked_div(b.number()).unwrap_or(0)),
                    "%" => Eval::Number(a.number().checked_rem(b.number()).unwrap_or(0)),
                    "===" | "==" => Eval::Bool(a == b),
                    "!==" | "!=" => Eval::Bool(a != b),
                    "<" => Eval::Bool(a.number() < b.number()),
                    "<=" => Eval::Bool(a.number() <= b.number()),
                    ">" => Eval::Bool(a.number() > b.number()),
                    ">=" => Eval::Bool(a.number() >= b.number()),
                    "&&" | "||" => b,
                    _ => Eval::Null,
                }
            }
            Expr::Unary { op, value } => {
                let v = sub(value);
                if op == "!" {
                    Eval::Bool(!v.truth())
                } else {
                    Eval::Number(v.number().saturating_neg())
                }
            }
            Expr::Conditional {
                condition,
                then,
                r#else,
            } => {
                if sub(condition).truth() {
                    sub(then)
                } else {
                    sub(r#else)
                }
            }
            Expr::Query {
                name,
                receiver,
                args,
            } => {
                if name == "hasSomeArenaUnit" || name == "arenaUnitCount" {
                    let Eval::Player(player) = sub(receiver) else {
                        return Eval::Null;
                    };
                    let predicate = &args[0];
                    let count = s
                        .player(player)
                        .ground
                        .as_slice()
                        .iter()
                        .chain(s.player(player).space.as_slice())
                        .filter(|&&card| {
                            self.eval_with_card(s, source, target, card, predicate)
                                .truth()
                        })
                        .count() as i64;
                    return if name == "hasSomeArenaUnit" {
                        Eval::Bool(count > 0)
                    } else {
                        Eval::Number(count)
                    };
                }
                if name == "hasInitiative" {
                    return Eval::Bool(matches!(sub(receiver), Eval::Player(p) if s.initiative==p));
                }
                let Eval::Card(id) = sub(receiver) else {
                    return Eval::Null;
                };
                if id == 0 {
                    return Eval::Null;
                }
                let d = self.def(s, id);
                match name.as_str() {
                    "isUnit" => Eval::Bool(
                        d.info.is("unit") || (d.info.is("leader") && s.card(id).deployed),
                    ),
                    "isNonLeaderUnit" => Eval::Bool(d.info.is("unit") && !d.info.is("leader")),
                    "isInPlay" => Eval::Bool(self.in_arena(s, id) || d.info.is("base")),
                    "canBeExhausted" => Eval::Bool(
                        d.info.is("unit")
                            || d.info.is("leader")
                            || d.info.is("event")
                            || d.info.is("upgrade"),
                    ),
                    "isUpgraded" => {
                        Eval::Bool(s.card(id).shield != 0 || s.card(id).experience != 0)
                    }
                    "isBase" => Eval::Bool(d.info.is("base")),
                    "isLeader" => Eval::Bool(d.info.is("leader")),
                    "getPower" => {
                        Eval::Number(
                            self.power(s, id, s.trigger_context == 2 && id == s.source) as i64
                        )
                    }
                    "getHp" => Eval::Number(self.hp(s, id) as i64),
                    "getCost" => Eval::Number(d.info.cost() as i64),
                    "hasSomeTrait" | "hasSomeAspect" | "hasSomeKeyword" => {
                        let values = match args.first().map(sub) {
                            Some(Eval::Array(v)) => v,
                            Some(v) => vec![v],
                            None => vec![],
                        };
                        Eval::Bool(values.iter().any(|v| {
                            if let Eval::Text(t) = v {
                                match name.as_str() {
                                    "hasSomeTrait" => d.traits.contains(t),
                                    "hasSomeAspect" => d.info.aspects().contains(t),
                                    _ => self.has_keyword(s, id, t),
                                }
                            } else {
                                false
                            }
                        }))
                    }

                    _ => Eval::Null,
                }
            }
        }
    }
    fn matching_targets(&self, s: &State, source: CardId, r: &TargetResolver) -> Vec<CardId> {
        let owner = s.card(source).owner;
        let mut out = Vec::new();
        for seat in [Seat::P1, Seat::P2] {
            if (r.owner == "self" && seat != owner) || (r.owner == "opponent" && seat == owner) {
                continue;
            }
            let p = s.player(seat);
            let candidates: Vec<CardId> = if r.zone.as_deref() == Some("discard") {
                p.discard.as_slice().to_vec()
            } else {
                p.ground
                    .as_slice()
                    .iter()
                    .chain(p.space.as_slice())
                    .copied()
                    .chain(std::iter::once(p.base))
                    .collect()
            };
            for id in candidates {
                let d = self.def(s, id);
                let base = id == p.base;
                let leader = d.info.is("leader");
                if match r.card_type.as_str() {
                    "unit" => !(d.info.is("unit") || (leader && s.card(id).deployed)),
                    "base" => !base,
                    "nonLeaderUnit" => !d.info.is("unit") || leader,
                    "leaderUnit" => !leader || !s.card(id).deployed,
                    _ => false,
                } {
                    continue;
                }
                if r.zone.as_deref() == Some("arena") && base
                    || r.zone.as_deref() == Some("base") && !base
                {
                    continue;
                }
                if let Some(arena) = &r.arena {
                    if d.info.arena.as_ref() != Some(arena) {
                        continue;
                    }
                }
                if r.predicate
                    .as_ref()
                    .is_some_and(|p| !self.eval(s, source, id, p).truth())
                {
                    continue;
                }
                out.push(id);
            }
        }
        out
    }
    fn effect_can_affect(
        &self,
        s: &State,
        source: CardId,
        target: CardId,
        e: &Effect,
        require_change: bool,
    ) -> bool {
        match e {
            Effect::Simultaneous { effects } | Effect::PhaseModifiers { effects } => return effects.iter().any(|e| self.effect_can_affect(s,source,target,e,require_change)),
            Effect::Select { target_resolver,effect } => return self.matching_targets(s,source,target_resolver).into_iter().any(|id| self.effect_can_affect(s,source,id,effect,require_change)),
            Effect::Conditional { condition,on_true,on_false } => return if self.eval(s,source,target,condition).truth() { self.effect_can_affect(s,source,target,on_true,require_change) } else { on_false.as_ref().is_some_and(|e| self.effect_can_affect(s,source,target,e,require_change)) },
            _ => {},
        }
        let mut context = *s;
        context.source = source;
        context.ability_target = target;
        if context.event_group.active { context.event_group.context=Selection::one(target); }
        let (dest, amount) = match e {
            Effect::ReadyResources { target, amount }
            | Effect::Damage { target, amount }
            | Effect::Heal { target, amount }
            | Effect::Draw { target, amount }
            | Effect::GiveShield { target, amount }
            | Effect::GiveExperience { target, amount }
            | Effect::GainKeyword { target, amount, .. } => (
                target,
                self.eval(&context, source, context.ability_target, amount)
                    .number(),
            ),
            Effect::ReturnToHand { target } | Effect::ModifyStats { target, .. } | Effect::LoseKeyword { target, .. } => (target, 1),
            Effect::Ready { target } | Effect::Exhaust { target } | Effect::Defeat { target } => {
                (target, 1)
            }
            _ => return false,
        };
        self.effect_targets(&context, dest)
            .into_iter()
            .any(|dest| match dest {
                Eval::Player(player) => {
                    if matches!(e, Effect::ReadyResources { .. }) {
                        !require_change
                            || s.player(player)
                                .resources
                                .as_slice()
                                .iter()
                                .any(|&id| s.card(id).exhausted)
                    } else {
                        matches!(e, Effect::Draw { .. }) && (!require_change || amount > 0)
                    }
                }
                Eval::Card(id) if id != 0 => {
                    let unit = self.in_arena(s, id);
                    let base = self.def(s, id).info.is("base");
                    match e {
                        Effect::Damage { .. } => (unit || base) && (!require_change || amount > 0),
                        Effect::Heal { .. } => {
                            (unit || base)
                                && (!require_change || (amount > 0 && s.card(id).damage > 0))
                        }
                        Effect::Ready { .. } => unit && (!require_change || s.card(id).exhausted),
                        Effect::Exhaust { .. } => {
                            unit && (!require_change || !s.card(id).exhausted)
                        }
                        Effect::Defeat { .. } => unit,
                        Effect::ReturnToHand { .. } => {
                            !self.def(s, id).info.is("leader")
                                && (unit || s.player(s.card(id).owner).discard.contains(id))
                        }
                        Effect::ModifyStats { .. } | Effect::GainKeyword { .. } | Effect::LoseKeyword { .. } => unit,
                        Effect::GiveShield { .. } | Effect::GiveExperience { .. } => {
                            unit && amount > 0
                        }
                        _ => false,
                    }
                }
                _ => false,
            })
    }
    fn instructions_can_affect(
        &self,
        s: &State,
        source: CardId,
        target: CardId,
        p: u16,
        start: usize,
        require_change: bool,
    ) -> bool {
        let instructions = &self.program(p).instructions;
        let mut pc = start;
        while let Some(instruction) = instructions.get(pc) {
            match instruction {
                Instruction::Commit => {}
                Instruction::Select(resolver) => {
                    return self.matching_targets(s, source, resolver).into_iter().any(
                        |candidate| {
                            self.instructions_can_affect(
                                s,
                                source,
                                candidate,
                                p,
                                pc + 1,
                                require_change,
                            )
                        },
                    );
                }
                Instruction::IfResult { .. } => break,
                Instruction::Apply(effect) | Instruction::Group(effect) => {
                    if self.effect_can_affect(s, source, target, effect, require_change) {
                        return true;
                    }
                }
                Instruction::Conditional { condition, skip } => {
                    if !self.eval(s, source, target, condition).truth() {
                        pc = *skip;
                        continue;
                    }
                }
                Instruction::Jump { to } => {
                    pc = *to;
                    continue;
                }
            }
            pc += 1;
        }
        false
    }
    fn program_targets(
        &self,
        s: &State,
        source: CardId,
        p: u16,
        pc: usize,
        r: &TargetResolver,
        require_change: bool,
    ) -> Vec<CardId> {
        self.matching_targets(s, source, r)
            .into_iter()
            .filter(|id| self.instructions_can_affect(s, source, *id, p, pc + 1, require_change))
            .collect()
    }
    fn program_has_effect(&self, s: &State, source: CardId, p: u16) -> bool {
        self.program_has_effect_mode(s, source, p, self.program(p).trigger != "action")
    }
    fn program_has_effect_mode(
        &self,
        s: &State,
        source: CardId,
        p: u16,
        require_change: bool,
    ) -> bool {
        match self.program(p).instructions.first() {
            Some(Instruction::Select(r)) => !self
                .program_targets(s, source, p, 0, r, require_change)
                .is_empty(),
            Some(Instruction::Apply(Effect::DistributeHealing {
                target_resolver, ..
            })) => !self.matching_targets(s, source, target_resolver).is_empty(),
            _ => self.instructions_can_affect(s, source, 0, p, 0, require_change),
        }
    }
    pub(super) fn program_menu_title(&self, s: &State, source: CardId, p: u16) -> String {
        let program = self.program(p);
        let title = if program.context_title.is_empty() { program.title.clone() } else {
            program.context_title.iter().map(|fragment| match self.eval(s, source, s.ability_target, fragment) {
                Eval::Text(value) => value,
                Eval::Number(value) => value.to_string(),
                Eval::Bool(value) => value.to_string(),
                Eval::Null => "null".into(),
                _ => "[object Object]".into(),
            }).collect::<String>()
        };
        if self.program_has_effect(s, source, p) {
            title.clone()
        } else {
            format!("(No effect) {title}")
        }
    }
    pub(super) fn is_ability_decision(&self, d: Decision) -> bool {
        matches!(
            d,
            Decision::AbilityMenu
                | Decision::AbilityTarget
                | Decision::AbilityOptional
                | Decision::AbilityNoEffect
                | Decision::AbilityDistribute
                | Decision::AbilityGroupShield
        )
    }
    pub(super) fn ability_actions(&self, s: &State) -> Vec<Action> {
        let mut out = Vec::new();
        let source = s.source;
        match s.decision {
            Decision::AbilityGroupShield => {
                if s.event_group.shield_count==0 { out.push(Action::button("You",0)); out.push(Action::button("Opponent",1)); }
                else { out.push(Action::button("Resolve next","next")); out.push(Action::button(format!("Resolve all ({})",s.event_group.shield_count),"all")); }
            }
            Decision::AbilityMenu => {
                for p in self.available_programs(s, source, "action") {
                    out.push(Action::button(
                        self.program_menu_title(s, source, p),
                        out.len(),
                    ));
                }
                if !s.card(source).exhausted {
                    out.push(Action::button("Attack", out.len()));
                }
                out.push(Action::button("Cancel", out.len()));
            }
            Decision::AbilityNoEffect => {
                out.push(Action::button(
                    if self.def(s, s.source).info.is("event") {
                        "Play anyway"
                    } else {
                        "Use it anyway"
                    },
                    0,
                ));
                out.push(Action::button("Cancel", 1));
            }
            Decision::AbilityOptional => {
                out.push(Action::button("Trigger", "trigger"));
                out.push(Action::button("Pass", "pass"));
            }
            Decision::AbilityTarget => {
                let p=self.program(s.ability_program-1);
                let (r,child)=if let Some((r,e))=self.current_group_resolver(s,p) { (r,Some(e)) } else {
                    let Instruction::Select(r)=&p.instructions[s.ability_pc as usize] else { unreachable!() }; (r,None)
                };
                if !s.ability_committed && s.ability_return==0 { out.push(Action::button("Cancel","cancel")); }
                if child.is_none() && p.optional && s.ability_pc==0 { out.push(Action::button("Pass","passAbility")); }
                let picks=if child.is_some() { s.event_group.picks } else { s.ability_selection };
                if r.is_multiple() {
                    if picks.len>0 { out.push(Action::button("Done","done")); }
                    else if r.optional { out.push(Action::button("Choose nothing","done")); }
                } else if r.optional {
                    if child.is_some() || s.ability_pc>0 && matches!(p.instructions[s.ability_pc as usize-1],Instruction::Commit) {
                        out.push(Action::button("Choose nothing","done"));
                    } else { out.push(Action::button("Choose no target","noTarget")); }
                }
                let candidates=if let Some(e)=child { self.group_candidates(s,r,e,false) } else {
                    self.program_targets(s,source,s.ability_program-1,s.ability_pc as usize,r,false)
                };
                for id in candidates {
                    if !r.is_multiple() || picks.len<r.max_targets().expect("validated selector") as u8 || picks.ids[..picks.len as usize].contains(&id) { out.push(self.card_action(s,id)); }
                }
            }
            Decision::AbilityDistribute => {
                let p = self.program(s.ability_program - 1);
                let Instruction::Apply(Effect::DistributeHealing {
                    amount,
                    target_resolver,
                    can_choose_no_targets,
                    can_distribute_less,
                    ..
                }) = &p.instructions[s.ability_pc as usize]
                else {
                    unreachable!()
                };
                let amount = self.eval(s, source, 0, amount).number().clamp(0, 2);
                let label = format!("distribute {amount}");
                if *can_choose_no_targets {
                    out.push(Action {
                        kind: "distribute".into(),
                        card: None,
                        arg: Some(json!([])),
                        method: None,
                        label: label.clone(),
                    });
                }
                for id in self.matching_targets(s, source, target_resolver) {
                    for n in 1..=amount {
                        if n != amount && !can_distribute_less {
                            continue;
                        }
                        out.push(Action {
                            kind: "distribute".into(),
                            card: None,
                            arg: Some(json!([[format!("c{}", id - 1), n]])),
                            method: None,
                            label: label.clone(),
                        });
                    }
                }
            }
            _ => {}
        }
        out
    }
    pub(super) fn begin_program(&self, s: &mut State, p: u16, return_to: u8) -> Result<(), String> {
        s.ability_program = p + 1;
        s.ability_pc = 0;
        s.ability_target = 0;
        s.ability_selection=Selection::default();
        s.event_group=EventGroupState::default();
        s.ability_result = 0;
        s.ability_succeeded = false;
        s.ability_return = return_to;
        s.ability_committed = return_to != 0;
        if self.program(p).optional
            && !matches!(
                self.program(p).instructions.first(),
                Some(Instruction::Select(_))
            )
            && self.program_has_effect(s, s.source, p)
        {
            s.decision = Decision::AbilityOptional;
            return Ok(());
        }
        if !self.program_has_effect_mode(s, s.source, p, false) {
            if return_to == 0 {
                s.decision = Decision::AbilityNoEffect;
                return Ok(());
            }
            return self.end_program(s);
        }
        if !self.program_has_effect(s, s.source, p) {
            if self.program(p).trigger == "event" {
                self.commit_program(s)?;
            }
            return self.end_program(s);
        }
        self.run_program(s)
    }
    fn commit_program(&self, s: &mut State) -> Result<(), String> {
        if s.ability_committed {
            return Ok(());
        }
        let source = s.source;
        if self.def(s, source).info.is("event") && s.player(s.active).hand.contains(source) {
            self.spend(s, self.cost(s, source));
            s.player_mut(s.active).hand.remove(source);
            s.player_mut(s.active).discard.push(source)?;
        }
        for cost in &self.program(s.ability_program - 1).costs {
            match cost {
                Cost::ExhaustSelf => s.card_mut(source).exhausted = true,
                Cost::Resources { amount } => self.spend(
                    s,
                    self.eval(s, source, s.ability_target, amount)
                        .number()
                        .clamp(0, u16::MAX as i64) as u16,
                ),
            }
        }
        s.ability_committed = true;
        Ok(())
    }
    fn end_program(&self, s: &mut State) -> Result<(), String> {
        let next = s.ability_return;
        s.ability_program = 0;
        s.ability_selection=Selection::default(); s.event_group=EventGroupState::default();
        if next == 1 {
            self.process_triggers(s)
        } else {
            self.finish(s)
        }
    }
    fn run_program(&self, s: &mut State) -> Result<(), String> {
        loop {
            let p = self.program(s.ability_program - 1);
            let Some(instruction) = p.instructions.get(s.ability_pc as usize) else {
                return self.end_program(s);
            };
            match instruction {
                Instruction::Commit => {
                    self.commit_program(s)?;
                    s.ability_pc += 1;
                }
                Instruction::Select(r) => {
                    if self
                        .program_targets(
                            s,
                            s.source,
                            s.ability_program - 1,
                            s.ability_pc as usize,
                            r,
                            true,
                        )
                        .is_empty()
                    {
                        s.ability_target = 0;
                        s.ability_selection=Selection::default();
                        s.ability_pc += 1;
                        continue;
                    }
                    s.decision = Decision::AbilityTarget;
                    return Ok(());
                }
                Instruction::Conditional { condition, skip } => {
                    s.ability_pc = if self.eval(s, s.source, s.ability_target, condition).truth() {
                        s.ability_pc + 1
                    } else {
                        *skip as u8
                    };
                }
                Instruction::IfResult { skip } => {
                    s.ability_pc = if s.ability_succeeded {
                        s.ability_pc + 1
                    } else {
                        *skip as u8
                    };
                }
                Instruction::Jump { to } => s.ability_pc = *to as u8,
                Instruction::Apply(Effect::DistributeHealing { .. }) => {
                    s.decision = Decision::AbilityDistribute;
                    return Ok(());
                }
                Instruction::Group(effect) => {
                    self.commit_program(s)?;
                    if !s.event_group.active {
                        s.event_group.active=true; s.event_group.initiator=s.active;
                        s.event_group.context=if s.ability_selection.len>0 { s.ability_selection } else { Selection::one(s.ability_target) };
                    }
                    if !self.generate_group(s,effect)? { return Ok(()); }
                    if !self.resolve_group(s,effect)? { return Ok(()); }
                    s.event_group=EventGroupState::default();
                    s.ability_selection=Selection::default();
                    s.ability_pc+=1;
                }
                Instruction::Apply(effect) => {
                    self.commit_program(s)?;
                    let (amount, resolved) = self.apply_effect(s, effect)?;
                    s.ability_result = amount;
                    s.ability_succeeded = resolved;
                    s.ability_pc += 1;
                }
            }
        }
    }
    fn current_group_resolver<'a>(&self, s: &State, p: &'a Program) -> Option<(&'a TargetResolver,&'a Effect)> {
        let Instruction::Group(effect)=&p.instructions[s.ability_pc as usize] else { return None; };
        match group_ops(effect).get(s.event_group.pc as usize) {
            Some(GroupOp::Select(r,e,_))=>Some((r,e)), _=>None,
        }
    }
    fn group_candidates(&self,s:&State,r:&TargetResolver,e:&Effect,require_change:bool)->Vec<CardId> {
        self.matching_targets(s,s.source,r).into_iter().filter(|id| self.effect_can_affect(s,s.source,*id,e,require_change)).collect()
    }
    fn capture_group_leaf(&self,s:&mut State,op:usize,e:&Effect)->Result<(),String> {
        let (target,amount)=match e {
            Effect::Damage{target,amount}|Effect::Heal{target,amount}|Effect::GiveShield{target,amount}|Effect::GiveExperience{target,amount}|Effect::GainKeyword{target,amount,..}=>(target,self.effect_amount(s,amount)?),
            Effect::Ready{target}|Effect::Exhaust{target}|Effect::Defeat{target}|Effect::ModifyStats{target,..}|Effect::LoseKeyword{target,..}=>(target,1),
            _=>return Err("unsupported group primitive".into()),
        };
        let (power,hp)=if let Effect::ModifyStats{power,hp,..}=e { (i32::try_from(self.eval(s,s.source,s.ability_target,power).number()).map_err(|_| "phase power delta exceeds capacity")?,i32::try_from(self.eval(s,s.source,s.ability_target,hp).number()).map_err(|_| "phase HP delta exceeds capacity")?) } else { (0,0) };
        if !(-65535..=65535).contains(&power) || !(-65535..=65535).contains(&hp) { return Err("phase stat delta exceeds capacity".into()); }
        for target in self.effect_targets(s,target) {
            let Eval::Card(target)=target else { continue; };
            if target==0 || !(self.in_arena(s,target)||self.def(s,target).info.is("base")) { continue; }
            if !self.effect_can_affect(s,s.source,s.ability_target,e,false) { continue; }
            if !self.in_arena(s,target) && !matches!(e,Effect::Damage{..}|Effect::Heal{..}) { continue; }
            let tokens=matches!(e,Effect::GiveShield{..}|Effect::GiveExperience{..});
            for _ in 0..if tokens { amount } else { 1 } {
                let mut record=PreparedEvent{op:op as u16,target,amount,power,hp,token:0};
                if tokens {
                    if s.next_id as usize>=MAX_CARDS { return Err("card capacity exceeded generating token".into()); }
                    record.token=s.next_id; s.next_id+=1;
                    let def=if matches!(e,Effect::GiveExperience{..}) { self.experience_def.ok_or("catalogue needs Experience token")? } else { self.shield_def };
                    *s.card_mut(record.token)=Card { present:true,def,owner:s.card(target).owner,..Card::default() };
                }
                if s.event_group.count>=32 { return Err("prepared event capacity exceeded".into()); }
                s.event_group.records[s.event_group.count as usize]=record; s.event_group.count+=1;
            }
        }
        Ok(())
    }
    fn generate_group(&self,s:&mut State,e:&Effect)->Result<bool,String> {
        let ops=group_ops(e);
        while let Some(op)=ops.get(s.event_group.pc as usize) {
            s.ability_target=s.event_group.context.ids[0];
            match op {
                GroupOp::Branch(expr,to)=> { if !self.eval(s,s.source,s.ability_target,expr).truth() { s.event_group.pc=*to as u16; continue; } }
                GroupOp::Jump(to)=> { s.event_group.pc=*to as u16; continue; }
                GroupOp::Select(r,child,end)=> {
                    if self.group_candidates(s,r,child,true).is_empty() { s.event_group.pc=*end as u16; continue; }
                    s.decision=Decision::AbilityTarget; return Ok(false);
                }
                GroupOp::Pop=> {
                    s.event_group.depth-=1;
                    s.event_group.context=s.event_group.stack[s.event_group.depth as usize];
                    s.event_group.stack[s.event_group.depth as usize]=Selection::default();
                }
                GroupOp::Leaf(effect)=>self.capture_group_leaf(s,s.event_group.pc as usize,effect)?,
            }
            s.event_group.pc+=1;
        }
        Ok(true)
    }
    fn group_shield_targets(&self,s:&State,e:&Effect,seat:Seat)->Vec<CardId> {
        let ops=group_ops(e); let mut targets=vec![];
        for r in &s.event_group.records[..s.event_group.count as usize] {
            if matches!(&ops[r.op as usize],GroupOp::Leaf(Effect::Damage{..})) && r.amount>0 && s.card(r.target).shield!=0 && s.card(r.target).owner==seat && !targets.contains(&r.target) { targets.push(r.target); }
        }
        targets
    }
    fn shield_attached(&self,s:&State,target:CardId,shield:CardId)->bool {
        let mut token=s.card(target).shield;
        while token!=0 { if token==shield { return true; } token=s.card(token).next_token; }
        false
    }
    fn consolidate_group_shields(&self,s:&mut State) {
        // Mirror ReplacementEffectWindow: stashed alternate contexts precede
        // the currently retained contexts; retain the first valid one per unit.
        let mut contexts=s.event_group.shield_stash[..s.event_group.shield_stash_len as usize].to_vec();
        for r in &s.event_group.records[..s.event_group.count as usize] {
            if r.amount>0 && r.token!=0 { contexts.push(r.token); }
        }
        let pending=(0..s.event_group.count as usize).filter(|i|s.event_group.records[*i].amount>0 && s.event_group.records[*i].token!=0).collect::<Vec<_>>();
        let mut selected=vec![];
        for i in pending {
            let target=s.event_group.records[i].target;
            if let Some(token)=contexts.iter().find(|id|self.shield_attached(s,target,**id)) {
                s.event_group.records[i].token=*token; selected.push(*token);
            }
        }
        let retained=contexts.into_iter().filter(|id|!selected.contains(id) && s.event_group.records[..s.event_group.count as usize].iter().any(|r|r.amount>0 && r.token!=0 && self.shield_attached(s,r.target,*id))).collect::<Vec<_>>();
        s.event_group.shield_stash=[0;MAX_CARDS]; s.event_group.shield_stash_len=retained.len() as u8;
        s.event_group.shield_stash[..retained.len()].copy_from_slice(&retained);
    }
    fn replace_group_damage(&self,s:&mut State,e:&Effect,target:CardId) {
        let ops=group_ops(e);
        if let Some(index)=(0..s.event_group.count as usize).find(|i| {
            let r=s.event_group.records[*i]; r.target==target && r.amount>0 && matches!(&ops[r.op as usize],GroupOp::Leaf(Effect::Damage{..}))
        }) {
            s.event_group.records[index].amount=0;
            self.consolidate_group_shields(s);
        }
    }
    pub(super) fn combat_shield_contexts(&self,s:&State,first:CardId,second:CardId)->(CardId,CardId) {
        // Combat uses the same replacement-window consolidation as prepared
        // effect groups. Capture both units' contexts before resolving either.
        let mut contexts=*s; contexts.event_group=EventGroupState::default(); contexts.event_group.count=2;
        for (index,target) in [first,second].into_iter().enumerate() {
            let mut tokens=vec![]; let mut token=s.card(target).shield;
            while token!=0 { tokens.push(token); token=s.card(token).next_token; }
            tokens.reverse();
            contexts.event_group.records[index]=PreparedEvent {target,amount:1,token:tokens[0],..PreparedEvent::default()};
            for token in tokens.into_iter().skip(1) {
                let len=contexts.event_group.shield_stash_len as usize;
                contexts.event_group.shield_stash[len]=token; contexts.event_group.shield_stash_len+=1;
            }
        }
        let first_token=contexts.event_group.records[0].token;
        contexts.event_group.records[0].amount=0;
        self.consolidate_group_shields(&mut contexts);
        (first_token,contexts.event_group.records[1].token)
    }
    pub(super) fn remove_group_shield(&self,s:&mut State,target:CardId,selected:CardId) {
        let mut token=s.card(target).shield; let mut previous=0;
        while token!=0 && token!=selected { previous=token; token=s.card(token).next_token; }
        if token==0 { return; }
        if previous==0 { s.card_mut(target).shield=s.card(selected).next_token; }
        else { s.card_mut(previous).next_token=s.card(selected).next_token; }
    }
    fn resolve_group(&self,s:&mut State,e:&Effect)->Result<bool,String> {
        let ops=group_ops(e);
        if !s.event_group.replacement_done {
            s.event_group.initiator=s.active;
            s.event_group.replacement_done=true;
            for r in &s.event_group.records[..s.event_group.count as usize] {
                if matches!(&ops[r.op as usize],GroupOp::Leaf(Effect::Damage{..})) && r.amount>0 && s.card(r.target).shield!=0 {
                    s.event_group.shield_mask|=1<<s.card(r.target).owner.index();
                }
            }
        }
        if s.event_group.shield_mask!=0 && s.event_group.records[..s.event_group.count as usize].iter().all(|r|r.token==0) {
            for i in 0..s.event_group.count as usize {
                let r=s.event_group.records[i];
                if !matches!(&ops[r.op as usize],GroupOp::Leaf(Effect::Damage{..})) || r.amount==0 { continue; }
                let mut tokens=vec![]; let mut token=s.card(r.target).shield;
                while token!=0 { tokens.push(token); token=s.card(token).next_token; }
                tokens.reverse();
                if let Some(first)=tokens.first() { s.event_group.records[i].token=*first; }
                for token in tokens.into_iter().skip(1) {
                    let len=s.event_group.shield_stash_len as usize;
                    s.event_group.shield_stash[len]=token; s.event_group.shield_stash_len+=1;
                }
            }
        }
        while s.event_group.shield_mask!=0 {
            if s.event_group.shield_mask==3 && s.event_group.shield_priority==0 {
                s.active=s.event_group.initiator; s.event_group.shield_count=0;
                s.decision=Decision::AbilityGroupShield; return Ok(false);
            }
            let seat=if s.event_group.shield_priority!=0 { if s.event_group.shield_priority==1 { Seat::P1 } else { Seat::P2 } }
                else if s.event_group.shield_mask&1!=0 { Seat::P1 } else { Seat::P2 };
            let targets=self.group_shield_targets(s,e,seat);
            if targets.len()>1 {
                s.active=seat; s.event_group.shield_count=targets.len() as u8;
                s.decision=Decision::AbilityGroupShield; return Ok(false);
            }
            for target in targets { self.replace_group_damage(s,e,target); }
            s.event_group.shield_mask&=!(1<<seat.index()); s.event_group.shield_priority=0;
        }
        s.active=s.event_group.initiator;
        s.event_group.resolving=true;
        // Token attachment contingents run after the primary handlers.
        let is_attachment=|i:usize|matches!(&ops[s.event_group.records[i].op as usize],GroupOp::Leaf(Effect::GiveShield{..}|Effect::GiveExperience{..}));
        let indices=(0..s.event_group.count as usize).filter(|i|!is_attachment(*i))
            .chain((0..s.event_group.count as usize).filter(|i|is_attachment(*i))).collect::<Vec<_>>();
        for index in indices {
            let r=s.event_group.records[index];
            let GroupOp::Leaf(effect)=&ops[r.op as usize] else { unreachable!() };
            if !self.in_arena(s,r.target)&&!self.def(s,r.target).info.is("base") { continue; }
            if r.token!=0 && matches!(effect,Effect::Damage{..}) {
                self.remove_group_shield(s,r.target,r.token);
                continue;
            }
            if r.token!=0 {
                let experience=matches!(effect,Effect::GiveExperience{..});
                let previous=if experience { s.card(r.target).experience } else { s.card(r.target).shield };
                s.card_mut(r.token).next_token=previous;
                if experience { s.card_mut(r.target).experience=r.token; } else { s.card_mut(r.target).shield=r.token; }
                continue;
            }
            let mut effect=(*effect).clone();
            let chosen=Target::Name("chosen".into());
            match &mut effect {
                Effect::Damage{target,amount}|Effect::Heal{target,amount}|Effect::GainKeyword{target,amount,..}=> { *target=chosen; *amount=Expr::number(r.amount as i64); }
                Effect::Ready{target}|Effect::Exhaust{target}|Effect::Defeat{target}|Effect::LoseKeyword{target,..}=>*target=chosen,
                Effect::ModifyStats{target,power,hp,..}=> { *target=chosen; *power=Expr::number(r.power as i64); *hp=Expr::number(r.hp as i64); }
                _=>unreachable!(),
            }
            s.event_group.context=Selection::one(r.target); s.ability_target=r.target;
            if matches!(effect,Effect::Damage{..}) {
                let hp=if self.def(s,r.target).info.is("base") { self.def(s,r.target).info.hp.unwrap_or(30).max(0) as u16 } else { self.hp(s,r.target) };
                let remaining=hp.saturating_sub(s.card(r.target).damage);
                if let Effect::Damage{amount,..}=&mut effect { *amount=Expr::number(r.amount.min(remaining) as i64); }
            }
            let (amount,resolved)=self.apply_effect(s,&effect)?;
            s.ability_result=s.ability_result.saturating_add(amount); s.ability_succeeded|=resolved;
        }
        s.event_group.resolving=false;
        // Damage callbacks capture their lethal set in handler/selection order,
        // before any queued source defeat can change another unit's HP aura.
        let mut damage_defeats=vec![];
        for r in &s.event_group.records[..s.event_group.count as usize] {
            if r.amount>0 && matches!(&ops[r.op as usize],GroupOp::Leaf(Effect::Damage{..})) && self.in_arena(s,r.target) && s.card(r.target).damage>=self.hp(s,r.target) && !damage_defeats.contains(&r.target) { damage_defeats.push(r.target); }
        }
        self.check_stat_capacity(s)?; self.check_win(s);
        // Framework HP checks queue their deaths before the defeat subwindow
        // removes any pending source; a negative aura cannot rescue them mid-batch.
        let framework_dead=s.players.iter().flat_map(|p|p.ground.as_slice().iter().chain(p.space.as_slice())).copied()
            .filter(|id|s.card(*id).damage>=self.hp(s,*id)).collect::<Vec<_>>();
        for id in framework_dead { if !damage_defeats.contains(&id) { damage_defeats.push(id); } }
        for id in damage_defeats { self.defeat(s,id)?; }
        self.sweep_stat_defeats(s)?;
        Ok(true)
    }
    fn effect_targets(&self, s: &State, target: &Target) -> Vec<Eval> {
        let owner = s.card(s.source).owner;
        match target {
            Target::Expression(e) => {
                fn flatten(value: Eval, out: &mut Vec<Eval>) {
                    match value {
                        Eval::Array(values) => {
                            for value in values {
                                flatten(value, out);
                            }
                        }
                        value => out.push(value),
                    }
                }
                let mut out = vec![];
                flatten(self.eval(s, s.source, s.ability_target, e), &mut out);
                out
            }
            Target::Name(n) => match n.as_str() {
                "self" => vec![Eval::Card(s.source)],
                "chosen" if s.event_group.active => s.event_group.context.ids[..s.event_group.context.len as usize].iter().map(|id| Eval::Card(*id)).collect(),
                "chosen" => vec![Eval::Card(s.ability_target)],
                "ownBase" => vec![Eval::Card(s.player(owner).base)],
                "enemyBase" => vec![Eval::Card(s.player(owner.other()).base)],
                "bothBases" => vec![Eval::Card(s.players[0].base), Eval::Card(s.players[1].base)],
                "ownPlayer" => vec![Eval::Player(owner)],
                "enemyPlayer" => vec![Eval::Player(owner.other())],
                "bothPlayers" => vec![Eval::Player(Seat::P1), Eval::Player(Seat::P2)],
                _ => vec![],
            },
        }
    }
    fn create_token(&self, s: &mut State, target: CardId, experience: bool) -> Result<(), String> {
        let def = if experience {
            self.experience_def
                .ok_or("catalogue needs Experience token")?
        } else {
            self.shield_def
        };
        if s.next_id as usize >= MAX_CARDS {
            return Err("card capacity exceeded creating token".into());
        }
        if experience {
            let mut check = *s;
            check.card_mut(target).phase_power = check
                .card(target)
                .phase_power
                .checked_add(1)
                .ok_or("computed power capacity")?;
            check.card_mut(target).phase_hp = check
                .card(target)
                .phase_hp
                .checked_add(1)
                .ok_or("computed HP capacity")?;
            self.check_stat_capacity(&check)?;
        }
        let id = s.next_id;
        s.next_id += 1;
        let previous = if experience {
            s.card(target).experience
        } else {
            s.card(target).shield
        };
        *s.card_mut(id) = Card {
            present: true,
            def,
            owner: s.card(target).owner,
            next_token: previous,
            ..Card::default()
        };
        if experience {
            s.card_mut(target).experience = id;
        } else {
            s.card_mut(target).shield = id;
        }
        Ok(())
    }
    fn effect_amount(&self, s: &State, e: &Expr) -> Result<u16, String> {
        let Eval::Number(n) = self.eval(s, s.source, s.ability_target, e) else {
            return Err("effect amount did not evaluate to an integer".into());
        };
        u16::try_from(n).map_err(|_| format!("effect amount {n} exceeds bounded runtime"))
    }
    fn apply_effect(&self, s: &mut State, e: &Effect) -> Result<(u16, bool), String> {
        if matches!(e, Effect::PhaseModifiers { .. }) {
            s.event_group.active=true;
            s.event_group.context=Selection::one(s.ability_target);
            self.generate_group(s,e)?; self.resolve_group(s,e)?;
            s.event_group=EventGroupState::default();
            return Ok((1,true));
        }
        if matches!(e, Effect::NoAction) {
            return Ok((0, false));
        }
        let (target, amount) = match e {
            Effect::ReadyResources { target, amount }
            | Effect::Damage { target, amount }
            | Effect::Heal { target, amount }
            | Effect::Draw { target, amount }
            | Effect::GiveShield { target, amount }
            | Effect::GiveExperience { target, amount }
            | Effect::GainKeyword { target, amount, .. } => (target, self.effect_amount(s, amount)?),
            Effect::ReturnToHand { target } | Effect::ModifyStats { target, .. } | Effect::LoseKeyword { target, .. } => (target, 1),
            Effect::Ready { target } | Effect::Exhaust { target } | Effect::Defeat { target } => {
                (target, 1)
            }
            _ => return Err("nonprimitive instruction reached executor".into()),
        };
        let modifier = if let Effect::ModifyStats { power, hp, .. } = e {
            Some((
                self.eval(s, s.source, s.ability_target, power).number(),
                self.eval(s, s.source, s.ability_target, hp).number(),
            ))
        } else {
            None
        };
        let targets = self.effect_targets(s, target);
        let mut result = 0u16;
        let mut replacement_resolved = false;
        let mut resources_fully_resolved = true;
        for target in targets {
            match target {
                Eval::Player(seat) if matches!(e, Effect::ReadyResources { .. }) => {
                    let resources = s.player(seat).resources;
                    let mut readied = 0;
                    for &id in resources.as_slice() {
                        if readied >= amount {
                            break;
                        }
                        if s.card(id).exhausted {
                            s.card_mut(id).exhausted = false;
                            readied += 1;
                            result = result.saturating_add(1);
                        }
                    }
                    resources_fully_resolved &= readied == amount;
                }
                Eval::Player(seat) if matches!(e, Effect::Draw { .. }) => {
                    for _ in 0..amount {
                        if let Some(id) = s.player_mut(seat).deck.pop_front() {
                            s.player_mut(seat).hand.push(id)?;
                            result = result.saturating_add(1);
                        } else {
                            let base = s.player(seat).base;
                            s.card_mut(base).damage = s.card(base).damage.saturating_add(3);
                        }
                    }
                }
                Eval::Card(id)
                    if id != 0
                        && (self.in_arena(s, id)
                            || self.def(s, id).info.is("base")
                            || (matches!(e, Effect::ReturnToHand { .. })
                                && s.player(s.card(id).owner).discard.contains(id))) =>
                {
                    let in_arena = self.in_arena(s, id);
                    match e {
                        Effect::Damage { .. } => {
                            replacement_resolved |= amount > 0 && s.card(id).shield != 0;
                            let before = s.card(id).damage;
                            self.damage(s, id, amount);
                            result =
                                result.saturating_add(s.card(id).damage.saturating_sub(before));
                        }
                        Effect::Heal { .. } => {
                            let heal = amount.min(s.card(id).damage);
                            s.card_mut(id).damage -= heal;
                            result = result.saturating_add(heal);
                        }
                        Effect::Ready { .. } if in_arena => {
                            result += u16::from(s.card(id).exhausted);
                            s.card_mut(id).exhausted = false;
                        }
                        Effect::Exhaust { .. } if in_arena => {
                            result += u16::from(!s.card(id).exhausted);
                            s.card_mut(id).exhausted = true;
                        }
                        Effect::ReturnToHand { .. } if !self.def(s, id).info.is("leader") => {
                            let owner = s.card(id).owner;
                            if in_arena {
                                self.leave_play(s, id)?;
                            }
                            s.player_mut(owner).discard.remove(id);
                            if !self.def(s, id).info.is("token") {
                                s.player_mut(owner).hand.push(id)?;
                            }
                            result += 1;
                        }
                        Effect::GainKeyword { keyword, .. } if in_arena => {
                            let index = crate::ability_ir::CORE_KEYWORDS.iter().position(|k| k == keyword).unwrap();
                            if index >= 6 { s.card_mut(id).phase_keyword_values[index - 6] = s.card(id).phase_keyword_values[index - 6].checked_add(amount).ok_or("phase keyword capacity exceeded")?; }
                            s.card_mut(id).phase_keyword_presence |= 1 << index;
                            result += 1;
                        }
                        Effect::LoseKeyword { keyword, .. } if in_arena => {
                            let index = crate::ability_ir::CORE_KEYWORDS.iter().position(|k| k == keyword).unwrap();
                            s.card_mut(id).phase_lost_keywords |= 1 << index;
                            result += 1;
                        }
                        Effect::ModifyStats { .. } if in_arena => {
                            let (power, hp) =
                                modifier.expect("stat modifier captured before event batch");
                            let next_power = s.card(id).phase_power as i64 + power;
                            let next_hp = s.card(id).phase_hp as i64 + hp;
                            if !(-65535..=65535).contains(&next_power)
                                || !(-65535..=65535).contains(&next_hp)
                            {
                                return Err("phase stat capacity exceeded".into());
                            }
                            let composed_power = self.def(s, id).info.power.unwrap_or(0) as i64
                                + self.token_count(s, s.card(id).experience) as i64
                                + if self.keyword_amount(s, id, "grit") > 0 {
                                    s.card(id).damage as i64
                                } else {
                                    0
                                }
                                + next_power;
                            let composed_hp = self.def(s, id).info.hp.unwrap_or(0) as i64
                                + self.token_count(s, s.card(id).experience) as i64
                                + next_hp;
                            if composed_power > 65535 || composed_hp > 65535 {
                                return Err("computed phase stats exceed capacity".into());
                            }
                            s.card_mut(id).phase_power = next_power as i32;
                            s.card_mut(id).phase_hp = next_hp as i32;
                            result += 1;
                        }
                        Effect::Defeat { .. } if in_arena => {
                            self.defeat(s, id)?;
                            result += 1;
                        }
                        Effect::GiveShield { .. } | Effect::GiveExperience { .. } if in_arena => {
                            for _ in 0..amount {
                                self.create_token(
                                    s,
                                    id,
                                    matches!(e, Effect::GiveExperience { .. }),
                                )?;
                                result = result.saturating_add(1);
                            }
                        }
                        _ => {}
                    }
                }
                _ => {}
            }
        }
        if !s.event_group.resolving { self.sweep_stat_defeats(s)?; self.check_win(s); }
        Ok((
            result,
            if matches!(e, Effect::ReadyResources { .. }) {
                resources_fully_resolved
            } else {
                result > 0 || replacement_resolved
            },
        ))
    }
    pub(super) fn apply_ability_action(&self, s: &State, a: &Action) -> Result<State, String> {
        let mut t = *s;
        match s.decision {
            Decision::AbilityGroupShield => {
                if s.event_group.shield_count==0 {
                    let seat=if a.arg.as_ref().and_then(Value::as_u64)==Some(0) { s.active } else { s.active.other() };
                    t.event_group.shield_priority=seat.index() as u8+1;
                } else {
                    let Instruction::Group(effect)=&self.program(s.ability_program-1).instructions[s.ability_pc as usize] else { unreachable!() };
                    let targets=self.group_shield_targets(s,effect,s.active);
                    let count=if a.arg.as_ref().and_then(Value::as_str)==Some("all") { targets.len() } else { 1 };
                    for target in targets.into_iter().take(count) { self.replace_group_damage(&mut t,effect,target); }
                    t.event_group.shield_priority=s.active.index() as u8+1;
                }
                self.run_program(&mut t)?;
            }
            Decision::AbilityMenu => {
                if a.label == "Cancel" {
                    self.cancel(&mut t);
                } else if a.label == "Attack" {
                    t.decision = Decision::AttackTarget;
                } else {
                    let index = a
                        .arg
                        .as_ref()
                        .and_then(Value::as_u64)
                        .ok_or("ability index missing")? as usize;
                    self.begin_program(
                        &mut t,
                        self.available_programs(s, s.source, "action")[index],
                        0,
                    )?;
                }
            }
            Decision::AbilityNoEffect => {
                if a.label == "Cancel" {
                    self.cancel(&mut t);
                } else {
                    self.commit_program(&mut t)?;
                    self.end_program(&mut t)?;
                }
            }
            Decision::AbilityOptional => {
                if a.arg.as_ref().and_then(Value::as_str) == Some("pass") {
                    self.end_program(&mut t)?;
                } else {
                    self.run_program(&mut t)?;
                }
            }
            Decision::AbilityTarget => {
                let p=self.program(s.ability_program-1);
                let nested=self.current_group_resolver(s,p);
                let r=if let Some((r,_))=nested { r } else { let Instruction::Select(r)=&p.instructions[s.ability_pc as usize] else { unreachable!() }; r };
                if a.arg.as_ref().and_then(Value::as_str)==Some("passAbility") { self.end_program(&mut t)?; }
                else if a.arg.as_ref().and_then(Value::as_str)==Some("cancel") { self.cancel(&mut t); }
                else {
                    if r.is_multiple() && a.id().is_some() {
                        if nested.is_some() { t.event_group.picks.toggle(a.id().unwrap()); }
                        else { t.ability_selection.toggle(a.id().unwrap()); }
                        return Ok(t);
                    }
                    let selected=if r.is_multiple() {
                        if nested.is_some() { t.event_group.picks } else { t.ability_selection }
                    } else { Selection::one(a.id().unwrap_or(0)) };
                    t.ability_target=selected.ids[0];
                    if nested.is_some() {
                        let depth=t.event_group.depth as usize;
                        t.event_group.stack[depth]=t.event_group.context; t.event_group.depth+=1;
                        t.event_group.context=selected; t.event_group.picks=Selection::default(); t.event_group.pc+=1;
                    } else { t.ability_selection=selected; t.ability_pc+=1; }
                    self.run_program(&mut t)?;
                }
            }
            Decision::AbilityDistribute => {
                self.commit_program(&mut t)?;
                t.ability_result = 0;
                t.ability_succeeded = false;
                if let Some(pair) = a
                    .arg
                    .as_ref()
                    .and_then(Value::as_array)
                    .and_then(|a| a.first())
                {
                    let id = cid(pair[0].as_str().ok_or("distribution target missing")?)?;
                    let heal = (pair[1].as_u64().ok_or("distribution amount missing")? as u16)
                        .min(t.card(id).damage);
                    t.card_mut(id).damage -= heal;
                    t.ability_result = heal;
                    t.ability_succeeded = heal > 0;
                }
                t.ability_pc += 1;
                self.run_program(&mut t)?;
            }
            _ => return Err("not an ability decision".into()),
        }
        self.sweep_stat_defeats(&mut t)?;
        Ok(t)
    }
    pub(super) fn queue_programs(&self, s: &mut State, trigger: &str) {
        s.pending_programs = 0;
        if self.catalogue.is_none() {
            return;
        }
        for (i, p) in self.card_programs(s, s.source).iter().enumerate() {
            let p = self.program(*p);
            if p.trigger == trigger
                && p.condition
                    .as_ref()
                    .is_none_or(|e| self.eval(s, s.source, 0, e).truth())
            {
                s.pending_programs |= 1 << i;
            }
        }
    }
    fn ordered_triggers(&self, s: &State) -> Vec<Trigger> {
        let mut out: Vec<_> = vec![];
        if self.catalogue.is_some() {
            for (i, p) in self.card_programs(s, s.source).iter().enumerate() {
                if s.pending_programs & (1 << i) != 0 {
                    out.push(Trigger::Program(i, *p));
                }
            }
        }
        out.extend(self.trigger_bits(s).into_iter().map(Trigger::Keyword));
        out.sort_by_key(|t| !match t {
            Trigger::Keyword(bit) => self.trigger_effect(s, *bit),
            Trigger::Program(_, p) => self.program_has_effect(s, s.source, *p),
        });
        out
    }
    pub(super) fn ordered_trigger_titles(&self, s: &State) -> Vec<String> {
        self.ordered_triggers(s)
            .iter()
            .map(|t| match t {
                Trigger::Keyword(bit) => {
                    let title = self.trigger_title(s, *bit);
                    if self.trigger_effect(s, *bit) {
                        title
                    } else {
                        format!("(No effect) {title}")
                    }
                }
                Trigger::Program(_, p) => self.program_menu_title(s, s.source, *p),
            })
            .collect()
    }
    pub(super) fn resolve_ordered_trigger(
        &self,
        s: &mut State,
        index: usize,
    ) -> Result<(), String> {
        match *self
            .ordered_triggers(s)
            .get(index)
            .ok_or("invalid trigger index")?
        {
            Trigger::Keyword(bit) => self.resolve_trigger(s, bit),
            Trigger::Program(i, p) => {
                s.pending_programs &= !(1 << i);
                self.begin_program(s, p, 1)
            }
        }
    }
    pub(super) fn process_all_triggers(&self, s: &mut State) -> Result<(), String> {
        if s.is_terminal() && s.trigger_context != 2 {
            return Ok(());
        }
        let triggers = self.ordered_triggers(s);
        if triggers.len() > 1 {
            if triggers.iter().all(|t| match t {
                Trigger::Keyword(bit) => !self.trigger_effect(s, *bit),
                Trigger::Program(_, p) => !self.program_has_effect(s, s.source, *p),
            }) {
                s.pending_triggers = 0;
                s.pending_programs = 0;
            } else {
                s.decision = Decision::TriggerOrder;
                return Ok(());
            }
        }
        if s.pending_triggers != 0 || s.pending_programs != 0 {
            return self.resolve_ordered_trigger(s, 0);
        }
        if s.trigger_context == 2 {
            if self.in_arena(s, s.source)
                && (self.in_arena(s, s.target) || self.def(s, s.target).info.is("base"))
            {
                self.combat(s)
            } else {
                self.finish(s)
            }
        } else {
            self.finish(s)
        }
    }
}

#[cfg(test)]
#[path = "generic_runtime_tests.rs"]
mod tests;
