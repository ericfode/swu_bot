//! Interpreter for the bounded, data-only card IR. No TypeScript runs in search.
use super::*;
use crate::ability_ir::{Cost, Effect, Expr, Instruction, Program, Target, TargetResolver};

#[derive(Clone, Debug, PartialEq)]
enum Eval {
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
                    if info.hp != Some(30)
                        || !info.text.as_deref().unwrap_or("").trim().is_empty()
                        || !programs.card.is_empty()
                    {
                        return Err("only plain 30 HP bases execute".into());
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
                            if name == "raid" {
                                raid = amount;
                            } else {
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
    pub fn hp(&self, s: &State, id: CardId) -> u16 {
        self.def(s, id).info.hp.unwrap_or(0).max(0) as u16
            + self.token_count(s, s.card(id).experience)
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
        let player = s.card(source).owner;
        let sub = |e| self.eval(s, source, target, e);
        match e {
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
                        Some("base") => Eval::Card(s.player(p).base),
                        Some("readyResourceCount") => {
                            Eval::Number(self.ready_resources(s, p) as i64)
                        }
                        Some("exhaustedResourceCount") => Eval::Number(
                            s.player(p).resources.len as i64 - self.ready_resources(s, p) as i64,
                        ),
                        Some("resources") => Eval::Number(s.player(p).resources.len as i64),
                        Some("hand") => Eval::Number(s.player(p).hand.len as i64),
                        Some("drawDeck") => Eval::Number(s.player(p).deck.len as i64),
                        _ => Eval::Null,
                    };
                }
                let id = if root == "source" { source } else { target };
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
                    Some("cost") => Eval::Number(self.def(s, id).info.cost() as i64),
                    Some("exhausted") => Eval::Bool(s.card(id).exhausted),
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
                let Eval::Card(id) = sub(receiver) else {
                    return Eval::Null;
                };
                if id == 0 {
                    return Eval::Null;
                }
                let d = self.def(s, id);
                let arg = args.first().map(sub);
                let text = if let Some(Eval::Text(t)) = arg {
                    t
                } else {
                    String::new()
                };
                match name.as_str() {
                    "isUnit" => Eval::Bool(self.in_arena(s, id)),
                    "isBase" => Eval::Bool(d.info.is("base")),
                    "isLeader" => Eval::Bool(d.info.is("leader")),
                    "getPower" => {
                        Eval::Number(
                            self.power(s, id, s.trigger_context == 2 && id == s.source) as i64
                        )
                    }
                    "getHp" => Eval::Number(self.hp(s, id) as i64),
                    "getCost" => Eval::Number(d.info.cost() as i64),
                    "hasSomeTrait" => Eval::Bool(d.traits.contains(&text)),
                    "hasSomeAspect" => Eval::Bool(d.info.aspects().contains(&text)),
                    "hasSomeKeyword" => Eval::Bool(d.info.has_keyword(&text)),
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
            for id in p
                .ground
                .as_slice()
                .iter()
                .chain(p.space.as_slice())
                .copied()
                .chain(std::iter::once(p.base))
            {
                let d = self.def(s, id);
                let base = id == p.base;
                let leader = d.info.is("leader");
                if match r.card_type.as_str() {
                    "unit" => base,
                    "base" => !base,
                    "nonLeaderUnit" => base || leader,
                    "leaderUnit" => base || !leader,
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
        let mut context = *s;
        context.source = source;
        context.ability_target = target;
        let (dest, amount) = match e {
            Effect::Damage { target, amount }
            | Effect::Heal { target, amount }
            | Effect::Draw { target, amount }
            | Effect::GiveShield { target, amount }
            | Effect::GiveExperience { target, amount } => (
                target,
                self.eval(&context, source, context.ability_target, amount)
                    .number(),
            ),
            Effect::Ready { target } | Effect::Exhaust { target } | Effect::Defeat { target } => {
                (target, 1)
            }
            _ => return false,
        };
        self.effect_targets(&context, dest)
            .into_iter()
            .any(|dest| match dest {
                Eval::Player(_) => {
                    matches!(e, Effect::Draw { .. }) && (!require_change || amount > 0)
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
                Instruction::Select(_) | Instruction::IfResult { .. } => break,
                Instruction::Apply(effect) => {
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
        let title = &self.program(p).title;
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
        )
    }
    pub(super) fn ability_actions(&self, s: &State) -> Vec<Action> {
        let mut out = Vec::new();
        let source = s.source;
        match s.decision {
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
                let p = self.program(s.ability_program - 1);
                let Instruction::Select(r) = &p.instructions[s.ability_pc as usize] else {
                    unreachable!()
                };
                if !s.ability_committed && s.ability_return == 0 {
                    out.push(Action::button("Cancel", "cancel"));
                }
                if p.optional && s.ability_pc == 0 {
                    out.push(Action::button("Pass", "passAbility"));
                }
                if r.optional {
                    out.push(Action::button("Choose no target", "noTarget"));
                }
                for id in self.program_targets(
                    s,
                    source,
                    s.ability_program - 1,
                    s.ability_pc as usize,
                    r,
                    false,
                ) {
                    out.push(self.card_action(s, id));
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
    fn effect_targets(&self, s: &State, target: &Target) -> Vec<Eval> {
        let owner = s.card(s.source).owner;
        match target {
            Target::Expression(e) => vec![self.eval(s, s.source, s.ability_target, e)],
            Target::Name(n) => match n.as_str() {
                "self" => vec![Eval::Card(s.source)],
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
        let (target, amount) = match e {
            Effect::Damage { target, amount }
            | Effect::Heal { target, amount }
            | Effect::Draw { target, amount }
            | Effect::GiveShield { target, amount }
            | Effect::GiveExperience { target, amount } => (target, self.effect_amount(s, amount)?),
            Effect::Ready { target } | Effect::Exhaust { target } | Effect::Defeat { target } => {
                (target, 1)
            }
            _ => return Err("nonprimitive instruction reached executor".into()),
        };
        let targets = self.effect_targets(s, target);
        let mut result = 0u16;
        let mut replacement_resolved = false;
        for target in targets {
            match target {
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
                    if id != 0 && (self.in_arena(s, id) || self.def(s, id).info.is("base")) =>
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
                    if in_arena && self.in_arena(s, id) && s.card(id).damage >= self.hp(s, id) {
                        self.defeat(s, id)?;
                    }
                }
                _ => {}
            }
        }
        self.check_win(s);
        Ok((result, result > 0 || replacement_resolved))
    }
    pub(super) fn apply_ability_action(&self, s: &State, a: &Action) -> Result<State, String> {
        let mut t = *s;
        match s.decision {
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
                if a.arg.as_ref().and_then(Value::as_str) == Some("passAbility") {
                    self.end_program(&mut t)?;
                } else if a.arg.as_ref().and_then(Value::as_str) == Some("cancel") {
                    self.cancel(&mut t);
                } else {
                    t.ability_target = a.id().unwrap_or(0);
                    t.ability_pc += 1;
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
        let mut out: Vec<_> = self
            .trigger_bits(s)
            .into_iter()
            .map(Trigger::Keyword)
            .collect();
        if self.catalogue.is_some() {
            for (i, p) in self.card_programs(s, s.source).iter().enumerate() {
                if s.pending_programs & (1 << i) != 0 {
                    out.push(Trigger::Program(i, *p));
                }
            }
        }
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
