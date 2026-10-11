//! Portable, data-only card abilities emitted by the TypeScript card compiler.
//!
//! The IR is deliberately smaller than TypeScript. It cannot call back into JS,
//! access host state, or smuggle an unimplemented engine operation through a
//! callback. Loading a card validates every instruction before play can begin.
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const SCHEMA: &str = "swu-card-ir/v1";
pub const MAX_PROGRAM_INSTRUCTIONS: usize = 128;
pub const MAX_ABILITY_NESTING: usize = 8;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum Expr {
    Const {
        value: Value,
    },
    Ref {
        path: Vec<String>,
    },
    Binary {
        op: String,
        left: Box<Expr>,
        right: Box<Expr>,
    },
    Unary {
        op: String,
        value: Box<Expr>,
    },
    Conditional {
        condition: Box<Expr>,
        then: Box<Expr>,
        r#else: Box<Expr>,
    },
    Query {
        name: String,
        receiver: Box<Expr>,
        #[serde(default)]
        args: Vec<Expr>,
    },
}
impl Expr {
    pub fn number(n: i64) -> Self {
        Self::Const {
            value: Value::from(n),
        }
    }
    pub fn validate(&self) -> Result<(), String> {
        self.validate_depth(0)
    }
    pub fn validate_number(&self) -> Result<(), String> {
        self.validate()?;
        let numeric = match self {
            Self::Const { value } => value.is_i64(),
            Self::Ref { path } => matches!(
                path.last().map(String::as_str),
                Some(
                    "damage"
                        | "power"
                        | "hp"
                        | "cost"
                        | "remainingHp"
                        | "readyResourceCount"
                        | "exhaustedResourceCount"
                        | "length"
                        | "totalDistributed"
                )
            ),
            Self::Binary { op, left, right } => {
                ["+", "-", "*", "%"].contains(&op.as_str())
                    && left.validate_number().is_ok()
                    && right.validate_number().is_ok()
            }
            Self::Unary { op, value } => op == "-" && value.validate_number().is_ok(),
            Self::Conditional { then, r#else, .. } => {
                then.validate_number().is_ok() && r#else.validate_number().is_ok()
            }
            Self::Query { name, .. } => ["getPower", "getHp", "getCost"].contains(&name.as_str()),
        };
        if numeric {
            Ok(())
        } else {
            Err("effect amount expression is not numeric".into())
        }
    }
    fn validate_depth(&self, depth: usize) -> Result<(), String> {
        if depth > MAX_ABILITY_NESTING {
            return Err("expression nesting exceeds runtime capacity".into());
        }
        let sub = |e: &Expr| e.validate_depth(depth + 1);
        match self {
            Self::Const { value }
                if value.is_i64() || value.is_boolean() || value.is_string() || value.is_null() =>
            {
                Ok(())
            }
            Self::Const { .. } => {
                Err("only integer, boolean, string and null constants are executable".into())
            }
            Self::Ref { path } => {
                let valid = match path
                    .iter()
                    .map(String::as_str)
                    .collect::<Vec<_>>()
                    .as_slice()
                {
                    ["source" | "target" | "card" | "player" | "opponent"] => true,
                    ["source" | "target" | "card", "damage" | "power" | "hp" | "cost" | "remainingHp" | "exhausted"
                    | "controller"] => true,
                    ["player" | "opponent", "readyResourceCount" | "exhaustedResourceCount" | "base"] => {
                        true
                    }
                    ["player" | "opponent", "resources" | "hand" | "drawDeck", "length"] => true,
                    ["event", "totalDistributed"] => true,
                    _ => false,
                };
                if valid {
                    Ok(())
                } else {
                    Err(format!("unsupported runtime reference {}", path.join(".")))
                }
            }
            Self::Binary { op, left, right } => {
                if ![
                    "+", "-", "*", "%", "===", "!==", "<", "<=", ">", ">=", "&&", "||",
                ]
                .contains(&op.as_str())
                {
                    return Err(format!("unsupported expression operator {op}"));
                }
                sub(left)?;
                sub(right)
            }
            Self::Unary { op, value } => {
                if !["!", "-"].contains(&op.as_str()) {
                    return Err(format!("unsupported unary operator {op}"));
                }
                sub(value)
            }
            Self::Conditional {
                condition,
                then,
                r#else,
            } => {
                sub(condition)?;
                sub(then)?;
                sub(r#else)
            }
            Self::Query {
                name,
                receiver,
                args,
            } => {
                let arity = match name.as_str() {
                    "isUnit" | "isBase" | "isLeader" | "getPower" | "getHp" | "getCost" => 0,
                    "hasSomeTrait" | "hasSomeAspect" | "hasSomeKeyword" => 1,
                    _ => return Err(format!("unsupported runtime query {name}")),
                };
                if args.len() != arity {
                    return Err(format!("query {name} expects {arity} arguments"));
                }
                sub(receiver)?;
                for arg in args {
                    sub(arg)?;
                }
                Ok(())
            }
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Target {
    Name(String),
    Expression(Expr),
}
impl Target {
    pub fn name(name: &str) -> Self {
        Self::Name(name.into())
    }
    pub fn validate(&self) -> Result<(), String> {
        match self {
            Self::Name(s)
                if [
                    "self",
                    "ownBase",
                    "enemyBase",
                    "bothBases",
                    "chosen",
                    "ownPlayer",
                    "enemyPlayer",
                    "bothPlayers",
                ]
                .contains(&s.as_str()) =>
            {
                Ok(())
            }
            Self::Name(s) => Err(format!("unsupported effect target {s}")),
            Self::Expression(e) => e.validate(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TargetResolver {
    #[serde(default = "any_owner")]
    pub owner: String,
    #[serde(rename = "type", default = "any_owner")]
    pub card_type: String,
    #[serde(default)]
    pub arena: Option<String>,
    #[serde(default)]
    pub zone: Option<String>,
    #[serde(default)]
    pub optional: bool,
    #[serde(default)]
    pub predicate: Option<Expr>,
}
fn any_owner() -> String {
    "any".into()
}
impl TargetResolver {
    pub fn validate(&self) -> Result<(), String> {
        if !["self", "opponent", "any"].contains(&self.owner.as_str()) {
            return Err(format!("unsupported target owner {}", self.owner));
        }
        if !["unit", "base", "any", "nonLeaderUnit", "leaderUnit"]
            .contains(&self.card_type.as_str())
        {
            return Err(format!("unsupported target type {}", self.card_type));
        }
        if self
            .arena
            .as_deref()
            .is_some_and(|a| !["ground", "space"].contains(&a))
        {
            return Err(format!("unsupported arena {:?}", self.arena));
        }
        if self
            .zone
            .as_deref()
            .is_some_and(|z| !["arena", "base", "anyAttackable"].contains(&z))
        {
            return Err(format!("unsupported target zone {:?}", self.zone));
        }
        if let Some(p) = &self.predicate {
            p.validate()?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum Cost {
    ExhaustSelf,
    Resources { amount: Expr },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum Effect {
    Damage {
        amount: Expr,
        target: Target,
    },
    Heal {
        amount: Expr,
        target: Target,
    },
    Draw {
        amount: Expr,
        target: Target,
    },
    Ready {
        target: Target,
    },
    Exhaust {
        target: Target,
    },
    Defeat {
        target: Target,
    },
    GiveShield {
        #[serde(default = "one")]
        amount: Expr,
        target: Target,
    },
    GiveExperience {
        #[serde(default = "one")]
        amount: Expr,
        target: Target,
    },
    Sequence {
        effects: Vec<Effect>,
    },
    Simultaneous {
        effects: Vec<Effect>,
    },
    Conditional {
        condition: Expr,
        #[serde(rename = "onTrue")]
        on_true: Box<Effect>,
        #[serde(rename = "onFalse", default)]
        on_false: Option<Box<Effect>>,
    },
    DistributeHealing {
        amount: Expr,
        #[serde(rename = "maxTargets")]
        max_targets: u16,
        #[serde(rename = "canChooseNoTargets", default)]
        can_choose_no_targets: bool,
        #[serde(rename = "canDistributeLess", default)]
        can_distribute_less: bool,
        #[serde(rename = "targetResolver")]
        target_resolver: TargetResolver,
    },
}
fn one() -> Expr {
    Expr::number(1)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Ability {
    #[serde(default)]
    pub trigger: String,
    pub title: String,
    #[serde(default)]
    pub costs: Vec<Cost>,
    #[serde(default)]
    pub optional: bool,
    #[serde(default)]
    pub requires_confirmation: bool,
    #[serde(default)]
    pub target_resolver: Option<TargetResolver>,
    #[serde(default)]
    pub condition: Option<Expr>,
    pub effect: Effect,
    #[serde(default)]
    pub then: Option<Box<Ability>>,
    #[serde(default)]
    pub if_you_do: Option<Box<Ability>>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Sides {
    #[serde(default)]
    pub leader: Vec<Ability>,
    #[serde(default)]
    pub unit: Vec<Ability>,
    #[serde(default)]
    pub card: Vec<Ability>,
}

#[derive(Debug, Clone)]
pub enum Instruction {
    Select(TargetResolver),
    Conditional { condition: Expr, skip: usize },
    IfResult { skip: usize },
    Jump { to: usize },
    Apply(Effect),
}

#[derive(Debug, Clone)]
pub struct Program {
    pub title: String,
    pub trigger: String,
    pub costs: Vec<Cost>,
    pub optional: bool,
    pub requires_confirmation: bool,
    pub condition: Option<Expr>,
    pub instructions: Vec<Instruction>,
}
impl Program {
    pub fn compile(ability: &Ability) -> Result<Self, String> {
        if !["action", "whenPlayed", "onAttack", "event"].contains(&ability.trigger.as_str()) {
            return Err(format!("unsupported runtime trigger {}", ability.trigger));
        }
        if ability.requires_confirmation {
            return Err("explicit confirmation semantics are not implemented".into());
        }
        if ability.trigger != "action" && !ability.costs.is_empty() {
            return Err("triggered or event additional costs are not implemented".into());
        }
        let mut p = Self {
            title: ability.title.clone(),
            trigger: ability.trigger.clone(),
            costs: ability.costs.clone(),
            optional: ability.optional,
            requires_confirmation: ability.requires_confirmation,
            condition: ability.condition.clone(),
            instructions: vec![],
        };
        if let Some(e) = &p.condition {
            e.validate()?;
        }
        if p.costs
            .iter()
            .filter(|c| matches!(c, Cost::ExhaustSelf))
            .count()
            > 1
        {
            return Err("duplicate exhaust cost cannot be paid".into());
        }
        let mut resource_cost = 0u64;
        for cost in &p.costs {
            if let Cost::Resources { amount } = cost {
                let Expr::Const { value } = amount else {
                    return Err("dynamic resource costs require typed bounded evaluation".into());
                };
                let amount = value
                    .as_u64()
                    .filter(|n| *n <= u16::MAX as u64)
                    .ok_or("resource cost must be a nonnegative bounded integer")?;
                resource_cost = resource_cost
                    .checked_add(amount)
                    .filter(|n| *n <= u16::MAX as u64)
                    .ok_or("total resource cost exceeds capacity")?;
            }
        }
        p.compile_ability(ability, 0)?;
        if p.instructions.len() > MAX_PROGRAM_INSTRUCTIONS {
            return Err("ability program exceeds instruction capacity".into());
        }
        Ok(p)
    }
    fn compile_ability(&mut self, ability: &Ability, depth: usize) -> Result<(), String> {
        if depth > MAX_ABILITY_NESTING {
            return Err("ability continuation nesting exceeds capacity".into());
        }
        if depth > 0
            && (!ability.costs.is_empty()
                || ability.optional
                || !ability.trigger.is_empty()
                || ability.condition.is_some()
                || ability.requires_confirmation)
        {
            return Err(
                "nested continuation costs, optional triggers and registrations are unsupported"
                    .into(),
            );
        }
        if let Some(target) = &ability.target_resolver {
            target.validate()?;
            self.instructions.push(Instruction::Select(target.clone()));
        }
        self.compile_effect(&ability.effect, depth)?;
        if let Some(next) = &ability.then {
            self.compile_ability(next, depth + 1)?;
        }
        if let Some(next) = &ability.if_you_do {
            let start = self.instructions.len();
            self.instructions.push(Instruction::IfResult { skip: 0 });
            self.compile_ability(next, depth + 1)?;
            self.instructions[start] = Instruction::IfResult {
                skip: self.instructions.len(),
            };
        }
        Ok(())
    }
    fn compile_effect(&mut self, effect: &Effect, depth: usize) -> Result<(), String> {
        if depth > MAX_ABILITY_NESTING {
            return Err("effect nesting exceeds capacity".into());
        }
        match effect {
            Effect::Sequence { effects } => { for effect in effects { self.compile_effect(effect, depth + 1)?; } }
            Effect::Conditional { condition, on_true, on_false } => {
                condition.validate()?;let start=self.instructions.len();self.instructions.push(Instruction::Conditional {condition:condition.clone(),skip:0});
                self.compile_effect(on_true,depth+1)?;let jump=self.instructions.len();self.instructions.push(Instruction::Jump{to:0});
                self.instructions[start]=Instruction::Conditional{condition:condition.clone(),skip:self.instructions.len()};
                if let Some(other)=on_false{self.compile_effect(other,depth+1)?;}
                self.instructions[jump]=Instruction::Jump{to:self.instructions.len()};
            }
            Effect::Simultaneous { .. } => return Err("simultaneous arbitrary effects require the event-batch runtime; syntax is converted but this card cannot execute yet".into()),
            Effect::DistributeHealing { amount, max_targets, target_resolver, .. } => {
                amount.validate_number()?;target_resolver.validate()?;
                if *max_targets != 1 { return Err("distribution runtime currently supports exactly one selected target".into()); }
                if !matches!(amount, Expr::Const{value} if value.as_u64().is_some_and(|n|n<=2)){return Err("distribution runtime currently supports up to two healing".into());}
                self.instructions.push(Instruction::Apply(effect.clone()));
            }
            Effect::Damage { amount, target } | Effect::Heal { amount, target } | Effect::Draw { amount, target } | Effect::GiveShield { amount, target } | Effect::GiveExperience { amount, target } => { amount.validate()?;target.validate()?;self.instructions.push(Instruction::Apply(effect.clone())); }
            Effect::Ready { target } | Effect::Exhaust { target } | Effect::Defeat { target } => { target.validate()?;self.instructions.push(Instruction::Apply(effect.clone())); }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Default)]
pub struct CardPrograms {
    pub leader: Vec<u16>,
    pub unit: Vec<u16>,
    pub card: Vec<u16>,
}

#[derive(Debug, Default)]
pub struct Catalogue {
    pub programs: Vec<Program>,
    pub cards: std::collections::HashMap<String, CardPrograms>,
    pub metadata: std::collections::HashMap<String, Value>,
    pub rejected: std::collections::BTreeMap<String, String>,
}
impl Catalogue {
    /// Converts every compiler entry into executable programs or a named, explicit
    /// rejection. A syntactically compiled card is never assumed executable.
    pub fn load(value: &Value) -> Result<Self, String> {
        if value["schema"] != SCHEMA {
            return Err(format!("unsupported ability IR schema {}", value["schema"]));
        }
        let entries = value["cards"]
            .as_array()
            .ok_or("IR catalogue needs cards")?;
        let mut catalogue = Self::default();
        for entry in entries {
            let code = entry["setCode"]
                .as_str()
                .ok_or("IR card missing setCode")?
                .to_owned();
            if catalogue.cards.contains_key(&code) || catalogue.rejected.contains_key(&code) {
                return Err(format!("duplicate IR card {code}"));
            }
            let result = || -> Result<(CardPrograms, Vec<Program>), String> {
                if entry["status"] != "supported" {
                    return Err(format!(
                        "compiler rejected {}: {}",
                        entry["internalName"], entry["diagnostics"]
                    ));
                }
                let sides: Sides = serde_json::from_value(entry["abilities"].clone())
                    .map_err(|e| format!("invalid ability IR: {e}"))?;
                let mut out = CardPrograms::default();
                let mut programs = Vec::new();
                for (src, dst) in [
                    (&sides.leader, &mut out.leader),
                    (&sides.unit, &mut out.unit),
                    (&sides.card, &mut out.card),
                ] {
                    for ability in src {
                        let id = catalogue.programs.len() + programs.len();
                        if id >= u16::MAX as usize {
                            return Err("ability program capacity exceeded".into());
                        }
                        dst.push(id as u16);
                        programs.push(Program::compile(ability)?);
                    }
                }
                Ok((out, programs))
            };
            match result() {
                Ok((card, programs)) => {
                    catalogue.programs.extend(programs);
                    catalogue.cards.insert(code.clone(), card);
                    catalogue.metadata.insert(code, entry["card"].clone());
                }
                Err(e) => {
                    catalogue.rejected.insert(
                        code,
                        format!(
                            "{}: {e}",
                            entry["internalName"].as_str().unwrap_or("unnamed card")
                        ),
                    );
                }
            }
        }
        Ok(catalogue)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn rejects_unknown_effects_instead_of_ignoring_them() {
        assert!(
            serde_json::from_value::<Effect>(json!({"kind":"capture","target":"chosen"})).is_err()
        );
    }
    #[test]
    fn rejects_unknown_fields_that_could_hide_additional_rules() {
        assert!(serde_json::from_value::<Effect>(json!({"kind":"damage","amount":{"kind":"const","value":1},"target":"chosen","lastingEffect":true})).is_err());
    }
    #[test]
    fn references_are_explicitly_bounded() {
        assert!(Expr::Ref {
            path: vec!["game".into(), "randomGenerator".into()]
        }
        .validate()
        .is_err());
        assert!(Expr::Ref {
            path: vec!["event".into(), "totalDistributed".into()]
        }
        .validate()
        .is_ok());
    }
    #[test]
    fn conditional_and_if_you_do_compile_real_continuations() {
        let a:Ability=serde_json::from_value(json!({"trigger":"action","title":"heal and pay","effect":{"kind":"heal","amount":{"kind":"const","value":2},"target":"self"},"ifYouDo":{"title":"pay","effect":{"kind":"damage","amount":{"kind":"ref","path":["event","totalDistributed"]},"target":"ownBase"}}})).unwrap();
        let p = Program::compile(&a).unwrap();
        assert!(matches!(
            p.instructions[1],
            Instruction::IfResult { skip: 3 }
        ));
    }
}
