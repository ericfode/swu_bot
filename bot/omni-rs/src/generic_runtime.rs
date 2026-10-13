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

fn reviewed_weakness_entry(entry:&Value)->bool {
    if entry["setCode"]!="TOKEN_WEAKNESS" {return false;}
    let expected:Value=serde_json::from_str(r#"{
  "title": "Weakness",
  "subtitle": "",
  "cost": 0,
  "hp": -1,
  "power": -1,
  "text": "",
  "deployBox": null,
  "epicAction": "",
  "unique": false,
  "rules": null,
  "upgradePower": -1,
  "upgradeHp": -1,
  "id": "7816991190",
  "aspects": [],
  "traits": [
    "condition"
  ],
  "keywords": [],
  "types": [
    "token",
    "upgrade"
  ],
  "setId": {
    "set": "HMW"
  },
  "internalName": "weakness"
}"#).expect("reviewed Weakness metadata");
    entry["setCode"]=="TOKEN_WEAKNESS" && entry["sourceHash"]=="dd546e4886757d77fffeb8be6e7381144fa7378b6493ce444aa87e4ba1202778" && entry["baseClass"]=="TokenUpgradeCard" && entry["card"]==expected && entry["keywordValues"]==serde_json::json!({}) && entry["abilities"]==serde_json::json!({"leader":[],"unit":[],"card":[]}) && entry["attachCondition"].is_null()
}
fn effect_has(e:&Effect,predicate:fn(&Effect)->bool)->bool {predicate(e)||match e {Effect::Simultaneous{effects}|Effect::PhaseModifiers{effects}|Effect::Sequence{effects}=>effects.iter().any(|e|effect_has(e,predicate)),Effect::Conditional{on_true,on_false,..}=>effect_has(on_true,predicate)||on_false.as_deref().is_some_and(|e|effect_has(e,predicate)),Effect::Select{effect,..}=>effect_has(effect,predicate),_=>false}}
fn program_has(p:&Program,predicate:fn(&Effect)->bool)->bool {p.instructions.iter().any(|i|match i {Instruction::Apply(e)=>effect_has(e,predicate),i=>i.group_effect().is_some_and(|e|effect_has(e,predicate))})}
fn program_needs_weakness(p:&Program)->bool {program_has(p,|e|matches!(e,Effect::GiveWeakness{..}))}
fn program_needs_beast(p:&Program)->bool {program_has(p,|e|matches!(e,Effect::CreateTokenUnit{token_type,..} if token_type=="beast"))}


fn reviewed_beast_entry(entry:&Value)->bool {
    let expected:Value=serde_json::from_str(r#"{"title":"Beast","subtitle":"","cost":0,"hp":3,"power":3,"text":"","deployBox":null,"epicAction":"","unique":false,"rules":null,"upgradePower":null,"upgradeHp":null,"id":"6445363199","aspects":[],"traits":["creature"],"arena":"ground","keywords":[],"types":["token","unit"],"setId":{"set":"HMW"},"internalName":"beast"}"#).expect("reviewed Beast metadata");
    entry["setCode"]=="TOKEN_BEAST"&&entry["status"]=="supported"&&entry["attachCondition"].is_null()&&entry["piloting"].is_null()&&entry["sourcePath"]=="game/cards/09_HMW/tokens/Beast.ts"&&entry["sourceHash"]=="e9ce58041d8cb93f9a98e773c016dc56bad9271ee30b7954411a7d63357c2566"&&entry["baseClass"]=="TokenUnitCard"&&entry["card"]==expected&&["card","unit","leader"].iter().all(|side|entry["abilities"][side].as_array().is_some_and(|a|a.is_empty()))&&entry["keywordValues"].as_object().is_some_and(|v|v.is_empty())
}
fn reviewed_force_entry(entry:&Value)->bool {
    if entry["setCode"]!="TOKEN_THE_FORCE" {return false;}
    let metadata:Value=serde_json::from_str(r#"{
  "title": "The Force",
  "subtitle": "",
  "cost": 0,
  "hp": null,
  "power": null,
  "text": "(The Force is with you. When you use the Force, remove this token from play.)",
  "deployBox": null,
  "epicAction": "",
  "unique": false,
  "rules": "An individual player may only control one Force token at a time. If a player already controls a Force token when they are instructed to create their Force token, nothing happens.\nEach player may create their own Force token. It is not shared between players.\n",
  "upgradePower": null,
  "upgradeHp": null,
  "id": "4571900905",
  "aspects": [],
  "traits": [],
  "keywords": [],
  "types": [
    "token"
  ],
  "setId": {
    "set": "LOF"
  },
  "internalName": "the-force"
}"#).expect("reviewed Force metadata");
    entry["sourceHash"]=="3ff3888f5186845acdd8d3ef96f396875b2daf4f9b808fa9b4a2ef03a1b954b6" && entry["baseClass"]=="TokenCard" && entry["card"]==metadata && entry["abilities"]==serde_json::json!({"leader":[],"unit":[],"card":[]}) && entry["keywordValues"]==serde_json::json!({}) && entry["attachCondition"].is_null()
}
fn program_needs_force(program:&Program)->bool {crate::ability_ir::contains_force_presence(program) || program.instructions.iter().any(|i|match i {Instruction::Apply(e)=>effect_has(e,|e|matches!(e,Effect::UseForce{..}|Effect::GainForce{..})),_=>i.group_effect().is_some_and(|e|effect_has(e,|e|matches!(e,Effect::UseForce{..}|Effect::GainForce{..})))})}

impl Engine {
    pub(super) fn needs_force_state(&self)->bool {
        self.catalogue.as_ref().is_some_and(|catalogue|catalogue.metadata.keys().any(|code|catalogue.cards.get(code).is_some_and(|card|card.card.iter().chain(&card.unit).chain(&card.leader).any(|p|program_needs_force(&catalogue.programs[*p as usize])))))
    }
    pub(super) fn needs_hidden_history(&self) -> bool {
        fn grants(v:&Value)->bool {match v {Value::Object(o)=>o.get("keyword").is_some_and(|k| k=="hidden") || o.values().any(grants),Value::Array(a)=>a.iter().any(grants),_=>false}}
        let Some(catalogue)=&self.catalogue else {return self.definitions.iter().any(|d|d.flags & (1<<8)!=0);};
        catalogue.metadata.keys().any(|code| {
            self.by_code.get(code).is_some_and(|i|self.definitions[*i as usize].flags & (1<<8)!=0) ||
            catalogue.cards.get(code).is_some_and(|c|c.card.iter().chain(&c.unit).chain(&c.leader).any(|id|grants(&serde_json::to_value(&catalogue.programs[*id as usize]).expect("serializable program"))))
        })
    }
    /// Load every fully executable card, retaining explicit reasons for all others.
    pub fn from_catalogue_value(value: &Value) -> Result<Self, String> {
        let mut catalogue = Catalogue::load(value)?;
        let force_available=value["cards"].as_array().ok_or("catalogue missing cards")?.iter().any(reviewed_force_entry);
        let weakness_available=value["cards"].as_array().ok_or("catalogue missing cards")?.iter().any(reviewed_weakness_entry);
        let beast_available=catalogue.cards.contains_key("TOKEN_BEAST")&&value["cards"].as_array().is_some_and(|cards|cards.iter().any(reviewed_beast_entry));
        let mut definitions = Vec::new();
        let mut by_code = HashMap::new();
        let mut shield_def = None;
        let mut experience_def = None;
        let mut weakness_def = None;
        let mut force_def = None;
        for entry in value["cards"].as_array().ok_or("catalogue missing cards")? {
            let code = entry["setCode"]
                .as_str()
                .ok_or("catalogue card missing code")?
                .to_owned();
            let native_token = matches!(code.as_str(), "TOKEN_SHIELD" | "TOKEN_EXPERIENCE" | "TOKEN_WEAKNESS" | "TOKEN_THE_FORCE");
            if !native_token && !catalogue.cards.contains_key(&code) {
                continue;
            }
            let result = (|| -> Result<Definition, String> {
                let info: CardInfo =
                    serde_json::from_value(entry["card"].clone()).map_err(|e| e.to_string())?;
                for field in ["cost", "power", "hp"] {
                    let value = &entry["card"][field];
                    if !value.is_null() && !(if info.is("upgrade") && field!="cost" {value.as_i64().is_some_and(|n|(-1000..=1000).contains(&n))}else{value.as_u64().is_some_and(|n| n <= 1000)}) {
                        return Err(format!("{field} must be an integer in 0..=1000"));
                    }
                }
                let programs = catalogue.cards.get(&code).cloned().unwrap_or_default();
                if !force_available && programs.card.iter().chain(&programs.unit).chain(&programs.leader).any(|p|program_needs_force(&catalogue.programs[*p as usize])) {return Err("reviewed Force token unavailable; dependent source cannot execute".into());}
                if !weakness_available && programs.card.iter().chain(&programs.unit).chain(&programs.leader).any(|p|program_needs_weakness(&catalogue.programs[*p as usize])) {return Err("Weakness token unavailable; dependent source cannot execute".into());}
                if !beast_available&&programs.card.iter().chain(&programs.unit).chain(&programs.leader).any(|p|program_needs_beast(&catalogue.programs[*p as usize])) {return Err("reviewed Beast token unavailable; dependent source cannot execute".into());}
                if programs.card.iter().chain(&programs.unit).chain(&programs.leader).any(|p|catalogue.programs[*p as usize].trigger=="onDefense") && (!info.is("unit") || info.is("leader") || info.is("token") || entry["baseClass"]!="NonLeaderUnitCard" || !programs.unit.is_empty() || !programs.leader.is_empty()) {return Err("OnDefense currently requires an ordinary nonleader unit source".into());}
                if native_token {
                    if code=="TOKEN_THE_FORCE" {
                        if !reviewed_force_entry(entry) {return Err("native Force source/metadata differs from reviewed adapter".into());}
                    }else {
                    let expected_hash = if code == "TOKEN_SHIELD" {
                        "39f1c6699c36ba309a8fe8e053f9b94ddbb8877991767b6664fcd88d447be91f"
                    } else if code=="TOKEN_EXPERIENCE" {
                        "fccf00d13061bfc15447101a0dc82fc360f9b5d2e28a9da678684e8c93bc9d67"
                    } else {"dd546e4886757d77fffeb8be6e7381144fa7378b6493ce444aa87e4ba1202778"};
                    if entry["sourceHash"] != expected_hash {
                        return Err("native token source changed; adapter requires review".into());
                    }
                    let bonus = if code == "TOKEN_SHIELD" { 0 } else if code=="TOKEN_EXPERIENCE" {1} else {-1};
                    for field in ["power", "hp", "upgradePower", "upgradeHp"] {
                        if entry["card"][field] != bonus {
                            return Err(format!(
                                "native token {field} differs from reviewed adapter"
                            ));
                        }
                    }
                    let expected = if code == "TOKEN_SHIELD" {
                        "shield"
                    } else if code=="TOKEN_EXPERIENCE" {
                        "experience"
                    } else {"weakness"};
                    if code=="TOKEN_WEAKNESS" && !reviewed_weakness_entry(entry) {return Err("native Weakness metadata differs from reviewed adapter".into());}
                    if info.internal_name != expected || !info.is("token") || !info.is("upgrade") {
                        return Err("invalid native token metadata".into());
                    }
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
                } else if info.is("upgrade") {
                    if entry["baseClass"]!="UpgradeCard" || entry["card"]["pilotText"].as_str().is_some_and(|v|!v.trim().is_empty()) {return Err("pilot/base upgrade execution is not implemented".into());}
                    for &p in &programs.card {
                        let program=&catalogue.programs[p as usize];
                        if !["constant","whenPlayed"].contains(&program.trigger.as_str()) {return Err("upgrade trigger requires dedicated framework event support".into());}
                        if program.trigger=="constant" && program.instructions.iter().any(|i|match i {Instruction::Apply(Effect::GainKeyword {target:Target::Name(n),..})=>n!="parent",Instruction::EndStep=>false,_=>true}) {return Err("upgrade constants require attached keyword grants".into());}
                    }
                    for field in ["upgradePower","upgradeHp"] {if !entry["card"][field].as_i64().is_some_and(|n|(-1000..=1000).contains(&n)) {return Err("upgrade printed stats must be bounded integers".into());}}
                } else if !info.is("unit") && !info.is("leader") {
                    return Err("runtime card type is not implemented".into());
                }
                let mut flags = 0;
                let mut raid = 0;
                let mut restore = 0;
                for keyword in entry["card"]["keywords"].as_array().into_iter().flatten() {
                    let name = keyword.as_str().ok_or("invalid keyword")?;
                    if name=="coordinate" {
                        if entry["keywordValues"][name].as_u64()!=Some(1) || programs.card.iter().filter(|&&id|catalogue.programs[id as usize].coordinate).count()!=1 || info.is("leader") {return Err("unimplemented printed Coordinate registration".into());}
                        continue;
                    }
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
                        "hidden" => flags |= 1 << 8,
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
                    if code=="TOKEN_WEAKNESS" {weakness_def=Some(id);}
                    if code=="TOKEN_THE_FORCE" {force_def=Some(id);}
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
            weakness_def,
            force_def,
            rules_backend: RulesBackend::Auto,
            rules_instrumentation: false,
            rules_hits: Default::default(),
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
        if !included.contains("TOKEN_WEAKNESS") && included.iter().any(|code|catalogue.cards.get(code).is_some_and(|c|c.card.iter().chain(&c.unit).chain(&c.leader).any(|p|program_needs_weakness(&catalogue.programs[*p as usize])))) {return Err("pool containing GiveWeakness cards must include reviewed TOKEN_WEAKNESS".into());}
        if !included.contains("TOKEN_THE_FORCE") && included.iter().any(|code|catalogue.cards.get(code).is_some_and(|c|c.card.iter().chain(&c.unit).chain(&c.leader).any(|p|program_needs_force(&catalogue.programs[*p as usize])))) {return Err("pool containing Force gain/use/presence cards must include reviewed TOKEN_THE_FORCE".into());}
        if !included.contains("TOKEN_BEAST")&&included.iter().any(|code|catalogue.cards.get(code).is_some_and(|c|c.card.iter().chain(&c.unit).chain(&c.leader).any(|p|program_needs_beast(&catalogue.programs[*p as usize])))) {return Err("pool containing Beast creation must include reviewed TOKEN_BEAST".into());}
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
                + constant_power + self.upgrade_stats(s,id).0
                + if self.keyword_amount(s, id, "grit") > 0 {
                    s.card(id).damage as i64
                } else {
                    0
                }
                + self.keyword_amount(s, id, "raid") as i64;
            let hp = d.info.hp.unwrap_or(0) as i64
                + self.token_count(s, s.card(id).experience) as i64
                + s.card(id).phase_hp as i64
                + constant_hp + self.upgrade_stats(s,id).1;
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
            let dead:Vec<_>=self.arena_units(s).into_iter().filter(|id|s.card(*id).damage>=self.hp(s,*id)).collect();
            if dead.is_empty() {
                return Ok(());
            }
            self.defeat_many(s,&dead)?;
        }
    }
    fn constant_effects<'a>(&'a self, s: &State, target: CardId, keywords: bool) -> Vec<(CardId, &'a Effect)> {
        if self.catalogue.is_none() || !self.in_arena(s, target) { return vec![]; }
        let mut effects = vec![];
        for source in 1..s.next_id {
            // Incoming unique copies have not activated their ongoing abilities:
            // the engine resolves uniqueness before resolveGameState.
            if !(self.in_arena(s, source)||self.attached_in_play(s,source))
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
                if (program.coordinate && !self.coordinate_active(s,source)) || program.trigger != "constant"
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
                let parent_target=program.instructions.iter().any(|i|matches!(i,Instruction::Apply(Effect::GainKeyword {target:Target::Name(n),..}) if n=="parent"));
                if resolver.map_or(if parent_target {s.card(source).parent!=target}else{source != target}, |r| {
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
                total.0 += self.eval_live_stat(s,source,target,power).number();
                total.1 += self.eval_live_stat(s,source,target,hp).number();
            }
        }
        total
    }
    fn raw_keyword_amount(&self, s: &State, target: CardId, keyword: &str) -> i64 {
        let Some(index) = crate::ability_ir::CORE_KEYWORDS.iter().position(|k| *k == keyword) else { return 0; };
        if s.card(target).lost_keyword_mask() & (1 << index) != 0 { return 0; }
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
        if crate::ability_ir::numeric_keyword_slot(index).is_none() { i64::from(total > 0) } else { total }
    }
    pub(super) fn keyword_amount(&self, s: &State, target: CardId, keyword: &str) -> u16 {
        self.raw_keyword_amount(s, target, keyword).clamp(0, u16::MAX as i64) as u16
    }
    pub(super) fn has_keyword(&self, s: &State, target: CardId, keyword: &str) -> bool {
        let Some(index) = crate::ability_ir::CORE_KEYWORDS.iter().position(|k| *k == keyword) else { return false; };
        if s.card(target).lost_keyword_mask() & (1 << index) != 0 { return false; }
        let effects = self.constant_effects(s, target, true);
        if effects.iter().any(|(_,e)| matches!(e, Effect::LoseKeyword {keyword: name, ..} if name == keyword)) { return false; }
        s.card(target).phase_keyword_mask() & (1 << index) != 0 || (self.def(s, target).flags & (1 << index) != 0 || (index == 6 && self.def(s, target).raid > 0) || (index == 7 && self.def(s, target).restore > 0)) || effects.iter().any(|(_,e)| matches!(e, Effect::GainKeyword {keyword: name, ..} if name == keyword))
    }
    pub(super) fn effective_flags(&self, s: &State, target: CardId) -> u16 {
        crate::ability_ir::CORE_KEYWORDS.iter().enumerate().filter(|(i,_)| crate::ability_ir::numeric_keyword_slot(*i).is_none()).fold(0, |flags, (i, k)| flags | if self.keyword_amount(s, target, k) > 0 { 1 << i } else { 0 })
    }
    fn raw_hp(&self,s:&State,id:CardId)->i64 {self.def(s,id).info.hp.unwrap_or(0) as i64+self.token_count(s,s.card(id).experience) as i64+s.card(id).phase_hp as i64+self.constant_stats(s,id).1+self.upgrade_stats(s,id).1}
    pub fn hp(&self,s:&State,id:CardId)->u16 {u16::try_from(self.raw_hp(s,id).max(0)).expect("HP exceeds validated compact capacity")}
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
    fn active_attack_pair(&self,s:&State,id:CardId)->(CardId,CardId) {
        if s.attack_source!=0 && (s.attack_source==id||s.attack_defender==id) {(s.attack_source,s.attack_defender)}else{s.death_frames[..s.death_depth as usize].iter().rev().find(|f|f.context.attack_source!=0&&(f.context.attack_source==id||f.context.attack_defender==id)).map(|f|(f.context.attack_source,f.context.attack_defender)).unwrap_or((0,0))}
    }
    pub(super) fn is_attacking(&self,s:&State,id:CardId)->bool {self.in_arena(s,id)&&id==self.active_attack_pair(s,id).0}
    fn is_defending(&self,s:&State,id:CardId)->bool {(self.in_arena(s,id)||self.def(s,id).info.is("base"))&&id==self.active_attack_pair(s,id).1}
    fn evaluated_power(&self,s:&State,id:CardId)->i64 {
        if self.def(s,id).info.is("upgrade") {self.def(s,id).info.upgrade_power.unwrap_or(0) as i64}
        else {self.raw_power(s,id,self.is_attacking(s,id)).max(0)}
    }
    fn evaluated_hp(&self,s:&State,id:CardId)->i64 {
        if self.def(s,id).info.is("upgrade") {self.def(s,id).info.upgrade_hp.unwrap_or(0) as i64}
        else {self.raw_hp(s,id).max(0)}
    }
    pub(super) fn attachment_condition(&self,s:&State,source:CardId,parent:CardId,e:&Expr)->bool {self.eval(s,source,parent,e).truth()}
    fn eval(&self, s: &State, source: CardId, target: CardId, e: &Expr) -> Eval {
        self.eval_with_card(s, source, target, target, e)
    }
    fn eval_live_stat(&self,s:&State,source:CardId,affected:CardId,e:&Expr)->Eval {self.eval_with_binding(s,source,affected,affected,affected,e)}
    fn eval_with_card(&self,s:&State,source:CardId,target:CardId,card:CardId,e:&Expr)->Eval {self.eval_with_binding(s,source,target,card,0,e)}
    fn eval_with_binding(
        &self,
        s: &State,
        source: CardId,
        target: CardId,
        card: CardId,
        modifier_target:CardId,
        e: &Expr,
    ) -> Eval {
        let player = s.card(source).owner;
        let sub = |e| self.eval_with_binding(s, source, target, card, modifier_target,e);
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
                        Some("hasTheForce") if root=="player" && path.len()==2 => Eval::Bool(s.force_state_exact && s.player(p).force_held),
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
                if root=="modifierTarget" {
                    assert!(modifier_target!=0,"modifierTarget unavailable outside persistent stat evaluation");
                    return match field {None=>Eval::Card(modifier_target),Some("damage")=>Eval::Number(s.card(modifier_target).damage as i64),Some("controller") if path.len()==2=>Eval::Player(s.card(modifier_target).owner),Some("controller") if path.iter().map(String::as_str).collect::<Vec<_>>()==["modifierTarget","controller","resources","length"]=>Eval::Number(s.player(s.card(modifier_target).owner).resources.len as i64),_=>Eval::Null};
                }
                if path.iter().map(String::as_str).collect::<Vec<_>>()==["card","activeAttack","attacker"] {return Eval::Card(self.active_attack_pair(s,card).0);}
                if root=="source" && matches!(field,Some("parentCard"|"parentUnit")) {
                    let parent=s.card(source).parent;
                    // Compiler permits parent access only on ordinary attached upgrades.
                    // Source registrations are evaluated while attachment is valid.
                    assert!(parent!=0 && self.in_arena(s,parent),"parentCard/parentUnit requires a live attached source");
                    if let Some(property)=path.get(2) {return self.eval_with_card(s,source,target,parent,&Expr::Ref {path:vec!["card".into(),property.clone()]});}
                    return Eval::Card(parent);
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
                            self.evaluated_power(s,id)
                        )
                    }
                    Some("hp") => Eval::Number(self.evaluated_hp(s,id)),
                    Some("remainingHp") => {
                        Eval::Number(self.hp(s, id).saturating_sub(s.card(id).damage) as i64)
                    }
                    Some("title") => Eval::Text(self.def(s, id).info.title.clone()),
                    Some("cost" | "printedCost") => Eval::Number(self.def(s, id).info.cost() as i64),
                    Some("exhausted") => Eval::Bool(s.card(id).exhausted),
                    Some("zoneName") => {
                        if self.attached_in_play(s,id) {return Eval::Text(if self.def(s,s.card(id).parent).info.arena.as_deref()==Some("space") {"spaceArena"}else{"groundArena"}.into());}
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
                            self.eval_with_binding(s, source, target, card,modifier_target,predicate)
                                .truth()
                        })
                        .count() as i64;
                    return if name == "hasSomeArenaUnit" {
                        Eval::Bool(count > 0)
                    } else {
                        Eval::Number(count)
                    };
                }
                if name=="resourcePairs" {return if let Eval::Player(p)=sub(receiver) {Eval::Number(s.player(p).resources.len as i64/2)}else{Eval::Null};}
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
                    "isAttacking"=>Eval::Bool(self.is_attacking(s,id)),
                    "isDefending"=>Eval::Bool(self.is_defending(s,id)),
                    "hasCost"=>Eval::Bool(["unit","leader","upgrade","event","token"].iter().any(|kind|d.info.is(kind))),
                    "isUpgrade"=>Eval::Bool(d.info.is("upgrade")),
                    "isTokenUnit"=>Eval::Bool(d.info.is("token")&&d.info.is("unit")),
                    "isNonLeaderUnit" => Eval::Bool(d.info.is("unit") && !d.info.is("leader")),
                    "isInPlay" => Eval::Bool(self.in_arena(s, id) || self.attached_in_play(s,id) || d.info.is("base")),
                    "canBeExhausted" => Eval::Bool(
                        d.info.is("unit")
                            || d.info.is("leader")
                            || d.info.is("event")
                            || d.info.is("upgrade"),
                    ),
                    "isUpgraded" => {
                        Eval::Bool(s.card(id).shield != 0 || s.card(id).experience != 0 || s.card(id).upgrades!=0)
                    }
                    "isToken" => Eval::Bool(d.info.is("token")),
                    "isBase" => Eval::Bool(d.info.is("base")),
                    "isLeader" => Eval::Bool(d.info.is("leader")),
                    "getPower" => {
                        Eval::Number(
                            self.evaluated_power(s,id)
                        )
                    }
                    "getHp" => Eval::Number(self.evaluated_hp(s,id)),
                    "getCost" | "getPrintedCost" => Eval::Number(d.info.cost() as i64),
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
            } else if r.is_upgrade_domain() {
                (1..s.next_id).filter(|id|s.card(*id).owner==seat && self.attached_in_play(s,*id)).collect()
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
                    "upgrade" => !d.info.is("upgrade"),
                    "any" if r.is_upgrade_domain()=>!d.info.is("upgrade"),
                    "tokenUnit"=> !(d.info.is("token")&&d.info.is("unit")),
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
            Effect::DiscardDeck {target,amount} | Effect::DiscardOwnHand {target,amount} | Effect::CreateTokenUnit {target,amount,..} | Effect::ReadyResources { target, amount }
            | Effect::Damage { target, amount }
            | Effect::Heal { target, amount }
            | Effect::Draw { target, amount }
            | Effect::GiveShield { target, amount }
            | Effect::GiveExperience { target, amount }
            | Effect::GiveWeakness {target,amount}
            | Effect::GainKeyword { target, amount, .. } => (
                target,
                self.eval(&context, source, context.ability_target, amount)
                    .number(),
            ),
            Effect::ResourceCard{target}|Effect::UseForce{target}|Effect::GainForce{target}|Effect::ReturnToHand { target } | Effect::ModifyStats { target, .. } | Effect::LoseKeyword { target, .. } => (target, 1),
            Effect::Ready { target } | Effect::Exhaust { target } | Effect::Defeat { target } => {
                (target, 1)
            }
            _ => return false,
        };
        self.effect_targets(&context, dest)
            .into_iter()
            .any(|dest| match dest {
                Eval::Player(player) => {
                    if matches!(e,Effect::UseForce{..}) {s.force_state_exact && s.player(player).force_held}
                    else if matches!(e,Effect::GainForce{..}) {s.force_state_exact && (!require_change || !s.player(player).force_held)}
                    else if matches!(e,Effect::DiscardDeck {..}) {amount>0 && (!require_change || s.player(player).deck.len>0)}
                    else if matches!(e,Effect::DiscardOwnHand {..}) {!require_change || (amount>0 && s.player(player).hand.len>0)}
                    else if matches!(e, Effect::ReadyResources { .. }) {
                        !require_change
                            || s.player(player)
                                .resources
                                .as_slice()
                                .iter()
                                .any(|&id| s.card(id).exhausted)
                    } else {
                        matches!(e, Effect::Draw { .. } | Effect::CreateTokenUnit {..}) && (!require_change || amount > 0)
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
                        Effect::Defeat { .. } => unit || self.attached_in_play(s,id),
                        Effect::ResourceCard {..} => self.resource_source_eligible(&context,id) && (!require_change || !s.player(s.card(id).owner).resources.contains(id)),
                        Effect::ReturnToHand { .. } => {
                            !self.def(s, id).info.is("leader")
                                && (unit || self.attached_in_play(s,id) || s.player(s.card(id).owner).discard.contains(id))
                        }
                        Effect::ModifyStats { .. } | Effect::GainKeyword { .. } | Effect::LoseKeyword { .. } => unit,
                        Effect::GiveShield { .. } | Effect::GiveExperience { .. } | Effect::GiveWeakness{..} => {
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
                Instruction::EndStep => {}
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
                Instruction::Apply(effect) | Instruction::Group(effect) | Instruction::NamedGroup(effect) | Instruction::NamedChooserGroup {effect,..} => {
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
        if self.program(p).trigger=="event"&&self.program(p).instructions.first().is_some_and(|i|matches!(i,Instruction::Group(Effect::Simultaneous{effects}) if effects.len()==2&&matches!(&effects[0],Effect::Select{effect,..} if matches!(effect.as_ref(),Effect::Damage{..}))&&matches!(&effects[1],Effect::GainForce{..}))) {return true;}
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
            Decision::DeathPlayer | Decision::DeathOrder | Decision::DeathBatch | Decision::AbilityMenu
                | Decision::AbilityTarget
                | Decision::AbilityOptional
                | Decision::AbilityNoEffect
                | Decision::AbilityDistribute
                | Decision::AbilityGroupShield | Decision::AbilityDiscard
        )
    }
    pub(super) fn ability_actions(&self, s: &State) -> Vec<Action> {
        let mut out = Vec::new();
        let source = s.source;
        match s.decision {
            Decision::AbilityDiscard => {
                let g=&s.event_group;
                if g.discard_count>1 && g.picks.len==g.discard_count {out.push(Action::button("Done","done"));}
                for &id in s.player(g.discard_owner).hand.as_slice() {if g.picks.len<g.discard_count || g.picks.ids[..g.picks.len as usize].contains(&id) {out.push(self.card_action(s,id));}}
            }
            Decision::DeathPlayer => {out.push(Action::button("You",0));out.push(Action::button("Opponent",1));}
            Decision::DeathOrder => {
                for g in self.death_groups(s) {let e=s.death_window.entries[g[0]];
                    let title=if g.len()>1 {let title=self.death_title(s,e,true);if !g.iter().any(|i|self.death_has_effect(s,s.death_window.entries[*i])) {format!("(No effect) {title}")}else{title}}else{self.death_title(s,e,false)};
                    out.push(Action::button(title,out.len().to_string()));}
            }
            Decision::DeathBatch => {
                let count=s.death_window.entries[..s.death_window.len as usize].iter().filter(|e|e.player==s.active && self.batch_member(s,**e)).count();
                out.push(Action::button("Resolve next","next"));out.push(Action::button(format!("Resolve all ({count})"),"all"));
            }
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
                let named=p.instructions[s.ability_pc as usize].is_named_group();
                if !named && !s.ability_committed && s.ability_return==0 { out.push(Action::button("Cancel","cancel")); }
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
                if named && !s.ability_committed && s.ability_return==0 { out.push(Action::button("Cancel","cancel")); }
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
        if next == 2 {
            self.process_deaths(s)
        } else if next == 1 {
            self.process_triggers(s)
        } else {
            self.finish(s)
        }
    }
    fn run_program(&self, s: &mut State) -> Result<(), String> {
        loop {
            if self.open_deaths(s,1)? {return Ok(());}
            let p = self.program(s.ability_program - 1);
            if self.rules_backend != RulesBackend::Interpreter {
                match p.executable {
                    Ok(index)=>{if self.rules_instrumentation {self.rules_hits.lock().expect("rules metrics lock").entry(s.ability_program as usize-1).or_default()[0]+=1;}if self.generated_step(s,p,index)? {return Ok(());} continue;},
                    Err(reason) if self.rules_backend==RulesBackend::Aot=>return Err(format!("AOT backend unavailable: {reason}")),
                    Err(_)=>{},
                }
            }
            if self.rules_instrumentation {self.rules_hits.lock().expect("rules metrics lock").entry(s.ability_program as usize-1).or_default()[1]+=1;}
            let Some(instruction) = p.instructions.get(s.ability_pc as usize) else {
                return self.end_program(s);
            };
            match instruction {
                Instruction::EndStep => {s.ability_pc+=1;}
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
                Instruction::Group(effect) | Instruction::NamedGroup(effect) | Instruction::NamedChooserGroup{effect,..} => {
                    let named=instruction.is_named_group();
                    if !named { self.commit_program(s)?; }
                    if !s.event_group.active {
                        s.ability_succeeded=false;
                        s.event_group.active=true; s.event_group.initiator=s.active;
                        s.event_group.context=if s.ability_selection.len>0 { s.ability_selection } else { Selection::one(s.ability_target) };
                    }
                    // Target prompts may temporarily hand active to the opposite chooser.
                    // Replacement prompts retain their own actor until resolve_group consumes them.
                    if matches!(instruction,Instruction::NamedChooserGroup{..}) && !s.event_group.replacement_done {s.active=s.event_group.initiator;}
                    if !self.generate_group(s,effect)? { return Ok(()); }
                    if named { self.commit_program(s)?; self.allocate_named_tokens(s,effect)?; }
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
                    if resolved&&matches!(effect,Effect::UseForce{..})&&p.instructions.iter().skip(s.ability_pc as usize+1).any(|i|matches!(i,Instruction::Apply(Effect::Defeat{target:Target::ArenaList(_)}))){self.sweep_stat_defeats(s)?;}
                    s.ability_pc += 1;
                }
            }
        }
    }
    fn current_group_resolver<'a>(&self, s: &State, p: &'a Program) -> Option<(&'a TargetResolver,&'a Effect)> {
        let effect=p.instructions[s.ability_pc as usize].group_effect()?;
        match group_ops(effect).get(s.event_group.pc as usize) {
            Some(GroupOp::Select(r,e,_))=>Some((r,e)), _=>None,
        }
    }
    fn group_candidates(&self,s:&State,r:&TargetResolver,e:&Effect,require_change:bool)->Vec<CardId> {
        self.matching_targets(s,s.source,r).into_iter().filter(|id| self.effect_can_affect(s,s.source,*id,e,require_change)).collect()
    }
    fn capture_group_leaf(&self,s:&mut State,op:usize,e:&Effect)->Result<(),String> {
        if matches!(e,Effect::GainForce{..}) {
            let Effect::GainForce{target}=e else{unreachable!()};
            let targets=self.effect_targets(s,target);if s.event_group.count as usize+targets.len()>32{return Err("prepared player event capacity exceeded".into());}
            for target in targets {let Eval::Player(player)=target else{return Err("Force group target must be a player".into());};let n=s.event_group.count as usize;s.event_group.records[n]=PreparedEvent{op:op as u16,target:s.player(player).base,amount:1,..PreparedEvent::default()};s.event_group.count+=1;}
            return Ok(());
        }

        if let Effect::DiscardDeck {target,amount}=e {
            let Eval::Player(player)=self.effect_targets(s,target).into_iter().next().ok_or("deck discard target missing")? else{return Err("deck discard requires a player target".into());};
            let requested=self.effect_amount(s,amount)?;
            if requested==0 {return Ok(());}
            let cards=s.player(player).deck.as_slice().iter().take(requested as usize).copied().collect::<Vec<_>>();
            if s.event_group.count as usize+cards.len()+1>32 {return Err("prepared deck discard event capacity exceeded".into());}
            for card in cards {
                let n=s.event_group.count as usize;
                s.event_group.records[n]=PreparedEvent {op:op as u16,target:card,amount:1,..PreparedEvent::default()};s.event_group.count+=1;
            }
            // Append the successful aggregate event even for an empty deck.
            let n=s.event_group.count as usize;
            s.event_group.records[n]=PreparedEvent {op:op as u16,target:s.player(player).base,amount:requested,..PreparedEvent::default()};s.event_group.count+=1;
            return Ok(());
        }
        if let Effect::Draw {target,amount}=e {
            let Eval::Player(player)=self.effect_targets(s,target).into_iter().next().ok_or("draw target missing")? else{return Err("group draw requires player target".into());};
            let n=s.event_group.count as usize;if n==32 {return Err("prepared draw event capacity exceeded".into());}
            let amount=self.effect_amount(s,amount)?;
            // DrawSystem generates fatigue contingents from the deck at event generation.
            let fatigue=amount.saturating_sub(s.player(player).deck.len as u16)*3;
            s.event_group.records[n]=PreparedEvent {op:op as u16,target:s.player(player).base,amount,hp:fatigue as i32,..PreparedEvent::default()};s.event_group.count+=1;return Ok(());
        }
        if let Effect::CreateTokenUnit {token_type,amount,target,enters_ready}=e {
            let code=match token_type.as_str() {"battleDroid"=>"TOKEN_BATTLE_DROID","cloneTrooper"=>"TOKEN_CLONE_TROOPER","beast"=>"TOKEN_BEAST","spy"=>"TOKEN_SPY","tieFighter"=>"TOKEN_TIE_FIGHTER","xwing"=>"TOKEN_XWING","mandalorian"=>"TOKEN_MANDALORIAN",_=>return Err("unsupported token unit type".into())};
            let def=*self.by_code.get(code).ok_or("created token definition missing from loaded pool")?;
            let amount=self.effect_amount(s,amount)? as usize;
            let targets=self.effect_targets(s,target);
            if s.next_id as usize+amount*targets.len()>MAX_CARDS {return Err("card capacity exceeded generating token units".into());}
            if s.event_group.count as usize+amount*targets.len()>32 {return Err("prepared token unit event capacity exceeded".into());}
            for target in targets {let Eval::Player(player)=target else{return Err("token unit target is not a player".into());};
                for _ in 0..amount {
                    let token=s.next_id;s.next_id+=1;*s.card_mut(token)=Card {present:true,owner:player,def,exhausted:!*enters_ready,..Card::default()};
                    let n=s.event_group.count as usize;s.event_group.records[n]=PreparedEvent {op:op as u16,target:s.player(player).base,amount:1,token,..PreparedEvent::default()};s.event_group.count+=1;
                }
            }
            return Ok(());
        }
        let (target,amount)=match e {
            Effect::Damage{target,amount}|Effect::Heal{target,amount}|Effect::GiveShield{target,amount}|Effect::GiveExperience{target,amount}|Effect::GiveWeakness{target,amount}|Effect::GainKeyword{target,amount,..}=>(target,self.effect_amount(s,amount)?),
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
            let tokens=matches!(e,Effect::GiveShield{..}|Effect::GiveExperience{..}|Effect::GiveWeakness{..});
            for _ in 0..if tokens { amount } else { 1 } {
                let mut record=PreparedEvent{op:op as u16,target,amount,power,hp,token:0};
                if tokens && !self.program(s.ability_program-1).instructions[s.ability_pc as usize].is_named_group() {
                    if s.next_id as usize>=MAX_CARDS { return Err("card capacity exceeded generating token".into()); }
                    record.token=s.next_id; s.next_id+=1;
                    let def=if matches!(e,Effect::GiveWeakness{..}) {self.weakness_def.ok_or("catalogue needs Weakness token")?}else if matches!(e,Effect::GiveExperience{..}) { self.experience_def.ok_or("catalogue needs Experience token")? } else { self.shield_def };
                    *s.card_mut(record.token)=Card { present:true,def,owner:s.card(target).owner,..Card::default() };
                }
                if s.event_group.count>=32 { return Err("prepared event capacity exceeded".into()); }
                s.event_group.records[s.event_group.count as usize]=record; s.event_group.count+=1;
            }
        }
        Ok(())
    }
    fn allocate_named_tokens(&self,s:&mut State,e:&Effect)->Result<(),String> {
        let ops=group_ops(e);
        let records=(0..s.event_group.count as usize).filter(|i|s.event_group.records[*i].token==0 && matches!(ops[s.event_group.records[*i].op as usize],GroupOp::Leaf(Effect::GiveShield{..}|Effect::GiveExperience{..}))).collect::<Vec<_>>();
        if s.next_id as usize+records.len()>MAX_CARDS {return Err("card capacity exceeded generating named tokens".into());}
        if records.iter().any(|i|matches!(ops[s.event_group.records[*i].op as usize],GroupOp::Leaf(Effect::GiveExperience{..}))) && self.experience_def.is_none() {return Err("catalogue needs Experience token".into());}
        for i in records {
            let r=s.event_group.records[i];let token=s.next_id;s.next_id+=1;
            let def=if matches!(ops[r.op as usize],GroupOp::Leaf(Effect::GiveExperience{..})) {self.experience_def.unwrap()} else {self.shield_def};
            *s.card_mut(token)=Card{present:true,def,owner:s.card(r.target).owner,..Card::default()};s.event_group.records[i].token=token;
        }
        Ok(())
    }
    fn uniform_damage_amount(&self,e:&Effect)->Option<u16> {
        match e { Effect::Damage {target:Target::ArenaList(_),amount:Expr::Const {value:Value::Number(n)}}=>n.as_u64().and_then(|n|u16::try_from(n).ok()),_=>None }
    }
    fn generate_uniform_damage(&self,s:&mut State,e:&Effect)->Result<bool,String> {
        if s.event_group.uniform_damage.active {return Ok(true);}
        let Effect::Damage {target,..}=e else {unreachable!()};
        let targets=self.effect_targets(s,target);
        let mut uniform=UniformDamageState::default();let mut stash=vec![];
        for value in targets {
            let Eval::Card(target)=value else {return Err("arena damage target is not a card".into());};
            if uniform.records[..uniform.count as usize].iter().any(|r|r.target()==target) {return Err("duplicate arena damage target".into());}
            let index=uniform.count as usize;if index==MAX_CARDS {return Err("arena damage capacity exceeded".into());}
            let mut shields=vec![];let mut shield=s.card(target).shield;
            while shield!=0 {shields.push(shield);shield=s.card(shield).next_token;}
            shields.reverse();
            uniform.records[index]=UniformDamageRecord::new(target,shields.first().copied().unwrap_or(0))?;
            uniform.count+=1;stash.extend(shields.into_iter().skip(1));
        }
        if stash.len()>u8::MAX as usize {return Err("Shield context capacity exceeded".into());}
        uniform.active=true;s.event_group.uniform_damage=uniform;
        s.event_group.shield_stash_len=stash.len() as u8;
        s.event_group.shield_stash[..stash.len()].copy_from_slice(&stash);
        Ok(true)
    }
    fn generate_group(&self,s:&mut State,e:&Effect)->Result<bool,String> {
        if s.event_group.pc==0&&matches!(e,Effect::GiveShield{..})&&s.event_group.context.len>3 {
            let Effect::GiveShield{target,..}=e else{unreachable!()};let n=self.effect_targets(s,target).into_iter().filter(|v|matches!(v,Eval::Card(id) if self.in_arena(s,*id))).count();
            if s.next_id as usize+n>MAX_CARDS||s.event_group.count as usize+n>32{return Err("five-pick Shield generation capacity exceeded".into());}
        }

        if s.event_group.pc==0&&effect_has(e,|e|matches!(e,Effect::GiveWeakness{..})) {
            self.weakness_def.ok_or("catalogue needs Weakness token")?;
            let mut tokens=0usize;let mut records=0usize;
            for op in group_ops(e) {let GroupOp::Leaf(effect)=op else{return Err("Weakness window must have scalar primary events".into());};
                let target=match effect {Effect::GiveWeakness{target,..}|Effect::Damage{target,..}=>target,_=>return Err("unsupported Weakness window primitive".into())};
                let count=self.effect_targets(s,target).into_iter().filter(|v|matches!(v,Eval::Card(id) if *id!=0&&self.in_arena(s,*id))).count();
                if let Effect::GiveWeakness{amount,..}=effect {let n=self.effect_amount(s,amount)? as usize;if !(1..=2).contains(&n){return Err("Weakness window amount must be one or two".into());}tokens+=n*count;records+=n*count;}else{records+=count;}
            }
            if s.next_id as usize+tokens>MAX_CARDS {return Err("card capacity exceeded generating Weakness".into());}
            if s.event_group.count as usize+records>32 {return Err("prepared Weakness window capacity exceeded".into());}
        }

        if self.uniform_damage_amount(e).is_some() {return self.generate_uniform_damage(s,e);}
        let ops=group_ops(e);
        while let Some(op)=ops.get(s.event_group.pc as usize) {
            s.ability_target=s.event_group.context.ids[0];
            match op {
                GroupOp::Branch(expr,to)=> { if !self.eval(s,s.source,s.ability_target,expr).truth() { s.event_group.pc=*to as u16; continue; } }
                GroupOp::Jump(to)=> { s.event_group.pc=*to as u16; continue; }
                GroupOp::Select(r,child,end)=> {
                    if let Instruction::NamedChooserGroup{choosers,..}=&self.program(s.ability_program-1).instructions[s.ability_pc as usize] {
                        let index=ops[..s.event_group.pc as usize].iter().filter(|op|matches!(op,GroupOp::Select(..))).count();
                        s.active=s.event_group.initiator;
                        if matches!(choosers[index],crate::ability_ir::NamedChooser::Opponent) {
                            // Opponent pretarget always delays until original-player costs are paid.
                            self.commit_program(s)?;s.active=s.event_group.initiator.other();
                        }
                    }
                    if self.group_candidates(s,r,child,true).is_empty() {
                        // A missing pretarget delays the remaining named resolver chain until costs.
                        if !s.ability_committed && self.program(s.ability_program-1).instructions[s.ability_pc as usize].is_named_group() && self.group_candidates(s,r,child,false).is_empty() {self.commit_program(s)?;}
                        if matches!(self.program(s.ability_program-1).instructions[s.ability_pc as usize],Instruction::NamedChooserGroup{..}) {s.active=s.event_group.initiator;}
                        s.event_group.pc=*end as u16; continue;
                    }
                    s.decision=Decision::AbilityTarget; return Ok(false);
                }
                GroupOp::Pop=> {
                    s.event_group.depth-=1;
                    s.event_group.context=s.event_group.stack[s.event_group.depth as usize];
                    s.event_group.stack[s.event_group.depth as usize]=Selection::default();
                }
                GroupOp::Leaf(Effect::DiscardOwnHand {amount,target})=> {
                    let Eval::Player(player)=self.effect_targets(s,target).into_iter().next().ok_or("discard target missing")? else{return Err("discard target is not a player".into());};
                    let count=(self.effect_amount(s,amount)? as usize).min(s.player(player).hand.len as usize);
                    if count>0 {s.event_group.discard_owner=player;s.event_group.discard_count=count as u8;s.active=player;s.decision=Decision::AbilityDiscard;return Ok(false);}
                }
                GroupOp::Leaf(effect)=>self.capture_group_leaf(s,s.event_group.pc as usize,effect)?,
            }
            s.event_group.pc+=1;
        }
        Ok(true)
    }
    fn group_shield_targets(&self,s:&State,e:&Effect,seat:Seat)->Vec<CardId> {
        let uniform=&s.event_group.uniform_damage;
        if uniform.active {return uniform.records[..uniform.count as usize].iter().enumerate().filter(|(i,r)|!uniform.is_prevented(*i)&&r.shield()!=0&&s.card(r.target()).owner==seat).map(|(_,r)|r.target()).collect();}
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
    fn consolidate_group_shields(&self,s:&mut State,e:Option<&Effect>) {
        let ops=e.map(group_ops);
        let damage=|r:&PreparedEvent|ops.as_ref().is_none_or(|ops|matches!(ops[r.op as usize],GroupOp::Leaf(Effect::Damage{..})));
        if s.event_group.uniform_damage.active {
            let mut contexts=s.event_group.shield_stash[..s.event_group.shield_stash_len as usize].to_vec();
            let pending=(0..s.event_group.uniform_damage.count as usize).filter(|i|!s.event_group.uniform_damage.is_prevented(*i)&&s.event_group.uniform_damage.records[*i].shield()!=0).collect::<Vec<_>>();
            contexts.extend(pending.iter().map(|i|s.event_group.uniform_damage.records[*i].shield()));
            let mut selected=vec![];
            for &i in &pending {
                let target=s.event_group.uniform_damage.records[i].target();
                if let Some(token)=contexts.iter().find(|id|self.shield_attached(s,target,**id)) {s.event_group.uniform_damage.records[i].shield=*token as u8;selected.push(*token);}
            }
            let retained=contexts.into_iter().filter(|id|!selected.contains(id)&&pending.iter().any(|i|self.shield_attached(s,s.event_group.uniform_damage.records[*i].target(),*id))).collect::<Vec<_>>();
            s.event_group.shield_stash=[0;MAX_CARDS];s.event_group.shield_stash_len=retained.len() as u8;
            s.event_group.shield_stash[..retained.len()].copy_from_slice(&retained);return;
        }
        // Mirror ReplacementEffectWindow: stashed alternate contexts precede
        // the currently retained contexts; retain the first valid one per unit.
        let mut contexts=s.event_group.shield_stash[..s.event_group.shield_stash_len as usize].to_vec();
        for r in &s.event_group.records[..s.event_group.count as usize] {
            if damage(r)&&r.amount>0 && r.token!=0 { contexts.push(r.token); }
        }
        let pending=(0..s.event_group.count as usize).filter(|i|damage(&s.event_group.records[*i])&&s.event_group.records[*i].amount>0 && s.event_group.records[*i].token!=0).collect::<Vec<_>>();
        let mut selected=vec![];
        for i in pending {
            let target=s.event_group.records[i].target;
            if let Some(token)=contexts.iter().find(|id|self.shield_attached(s,target,**id)) {
                s.event_group.records[i].token=*token; selected.push(*token);
            }
        }
        let retained=contexts.into_iter().filter(|id|!selected.contains(id) && s.event_group.records[..s.event_group.count as usize].iter().any(|r|damage(r)&&r.amount>0 && r.token!=0 && self.shield_attached(s,r.target,*id))).collect::<Vec<_>>();
        s.event_group.shield_stash=[0;MAX_CARDS]; s.event_group.shield_stash_len=retained.len() as u8;
        s.event_group.shield_stash[..retained.len()].copy_from_slice(&retained);
    }
    fn replace_group_damage(&self,s:&mut State,e:&Effect,target:CardId) {
        if s.event_group.uniform_damage.active {
            if let Some(i)=(0..s.event_group.uniform_damage.count as usize).find(|i|s.event_group.uniform_damage.records[*i].target()==target&&!s.event_group.uniform_damage.is_prevented(*i)) {s.event_group.uniform_damage.prevent(i);self.consolidate_group_shields(s,Some(e));}
            return;
        }
        let ops=group_ops(e);
        if let Some(index)=(0..s.event_group.count as usize).find(|i| {
            let r=s.event_group.records[*i]; r.target==target && r.amount>0 && matches!(&ops[r.op as usize],GroupOp::Leaf(Effect::Damage{..}))
        }) {
            s.event_group.records[index].amount=0;
            self.consolidate_group_shields(s,Some(e));
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
        self.consolidate_group_shields(&mut contexts,None);
        (first_token,contexts.event_group.records[1].token)
    }
    pub(super) fn remove_group_shield(&self,s:&mut State,target:CardId,selected:CardId) {
        let mut token=s.card(target).shield; let mut previous=0;
        while token!=0 && token!=selected { previous=token; token=s.card(token).next_token; }
        if token==0 { return; }
        if previous==0 { s.card_mut(target).shield=s.card(selected).next_token; }
        else { s.card_mut(previous).next_token=s.card(selected).next_token; }
        self.detach(s,selected);s.card_mut(selected).next_token=0;
    }
    fn resolve_uniform_damage(&self,s:&mut State,e:&Effect)->Result<bool,String> {
        let amount=self.uniform_damage_amount(e).ok_or("invalid uniform damage effect")?;
        if !s.event_group.replacement_done {
            s.event_group.initiator=s.active;s.event_group.replacement_done=true;
            for r in &s.event_group.uniform_damage.records[..s.event_group.uniform_damage.count as usize] {if r.shield()!=0 {s.event_group.shield_mask|=1<<s.card(r.target()).owner.index();}}
        }
        while s.event_group.shield_mask!=0 {
            if s.event_group.shield_mask==3&&s.event_group.shield_priority==0 {s.active=s.event_group.initiator;s.event_group.shield_count=0;s.decision=Decision::AbilityGroupShield;return Ok(false);}
            let seat=if s.event_group.shield_priority!=0 {if s.event_group.shield_priority==1 {Seat::P1}else {Seat::P2}}else if s.event_group.shield_mask&1!=0 {Seat::P1}else {Seat::P2};
            let targets=self.group_shield_targets(s,e,seat);
            if targets.len()>1 {s.active=seat;s.event_group.shield_count=targets.len() as u8;s.decision=Decision::AbilityGroupShield;return Ok(false);}
            for target in targets {self.replace_group_damage(s,e,target);}
            s.event_group.shield_mask&=!(1<<seat.index());s.event_group.shield_priority=0;
        }
        s.active=s.event_group.initiator;s.ability_result=0;s.ability_succeeded=false;s.event_group.resolving=true;
        let mut callbacks=vec![];
        for i in 0..s.event_group.uniform_damage.count as usize {
            let record=s.event_group.uniform_damage.records[i];let target=record.target();
            if !self.in_arena(s,target) {continue;}
            if s.event_group.uniform_damage.is_prevented(i) {self.remove_group_shield(s,target,record.shield());continue;}
            s.event_group.context=Selection::one(target);s.ability_target=target;
            let remaining=self.hp(s,target).saturating_sub(s.card(target).damage);
            let (applied,resolved)=self.apply_effect(s,&Effect::Damage {target:Target::Name("chosen".into()),amount:Expr::number(amount.min(remaining) as i64)})?;
            if applied>0 {callbacks.push(target);}
            s.ability_result=s.ability_result.saturating_add(applied);s.ability_succeeded|=resolved;
        }
        s.event_group.resolving=false;self.finish_group_damage(s,callbacks)?;Ok(true)
    }
    fn resolve_group(&self,s:&mut State,e:&Effect)->Result<bool,String> {
        let drain=matches!(e,Effect::Simultaneous{effects} if effects.len()==2&&matches!(&effects[0],Effect::Select{effect,..} if matches!(effect.as_ref(),Effect::Damage{..}))&&matches!(&effects[1],Effect::GainForce{..}));
        let mut cached_lethals=Vec::new();

        if s.event_group.uniform_damage.active {return self.resolve_uniform_damage(s,e);}
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
        if s.event_group.shield_mask!=0 && s.event_group.records[..s.event_group.count as usize].iter().filter(|r|matches!(&ops[r.op as usize],GroupOp::Leaf(Effect::Damage{..}))).all(|r|r.token==0) {
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
        // All explicit defeat registrations see the same pre-movement event state.
        let mut explicit_sources=vec![];
        for r in &s.event_group.records[..s.event_group.count as usize] {
            if matches!(&ops[r.op as usize],GroupOp::Leaf(Effect::Defeat{..})) && self.in_arena(s,r.target) && !explicit_sources.contains(&r.target) {explicit_sources.push(r.target);}
        }
        for &id in &explicit_sources {self.capture_explicit_death(s,id)?;}
        // Cleanup contingents belong to the whole prepared window. The pinned
        // unary event-order comparator reverses their combined insertion order
        // ahead of every primary handler, rather than interleaving per parent.
        let cleanup=s.event_group.records[..s.event_group.count as usize].iter().filter(|r|matches!(&ops[r.op as usize],GroupOp::Leaf(Effect::Defeat {..})) && self.in_arena(s,r.target)).flat_map(|r|self.upgrades(s,r.target)).collect::<Vec<_>>();
        for upgrade in cleanup.into_iter().rev() {if s.card(upgrade).parent!=0 {self.leave_play_primary(s,upgrade)?;}}
        // Generation can read the preceding step's numeric event context.
        // Reset the new group's result only after those values are captured.
        s.ability_result=0;s.ability_succeeded=false;
        s.event_group.resolving=true;
        // Attachment, unit-entry and draw-fatigue contingents retain record order
        // after every primary handler has finished.
        let is_attachment=|i:usize|matches!(&ops[s.event_group.records[i].op as usize],GroupOp::Leaf(Effect::GiveShield{..}|Effect::GiveExperience{..}|Effect::GiveWeakness{..}|Effect::CreateTokenUnit{..}));
        let is_draw=|i:usize|matches!(&ops[s.event_group.records[i].op as usize],GroupOp::Leaf(Effect::Draw{..}));
        let indices=(0..s.event_group.count as usize).filter(|i|!is_attachment(*i)).map(|i|(i,false))
            .chain((0..s.event_group.count as usize).filter(|i|is_attachment(*i)||is_draw(*i)).map(|i|(i,true))).collect::<Vec<_>>();
        let mut damage_callbacks=vec![];
        for (index,contingent) in indices {
            let r=s.event_group.records[index];
            let GroupOp::Leaf(effect)=&ops[r.op as usize] else { unreachable!() };
            if matches!(effect,Effect::DiscardDeck {..}) {
                if self.def(s,r.target).info.is("base") {s.ability_succeeded=true;}
                else {
                    let owner=s.card(r.target).owner;
                    if s.player_mut(owner).deck.remove(r.target) {s.player_mut(owner).discard.push(r.target)?;s.ability_result=s.ability_result.saturating_add(1);}
                }
                continue;
            }
            if matches!(effect,Effect::DiscardOwnHand {..}) {
                let owner=s.card(r.target).owner;
                if s.player_mut(owner).hand.remove(r.target) {s.player_mut(owner).discard.push(r.target)?;s.ability_result=s.ability_result.saturating_add(1);s.ability_succeeded=true;}
                continue;
            }
            if let Effect::Draw {target,..}=effect {
                if contingent {
                    let hp=self.def(s,r.target).info.hp.unwrap_or(30) as u16;
                    s.card_mut(r.target).damage=s.card(r.target).damage.saturating_add(r.hp as u16).min(hp);
                    continue;
                }
                let (amount,resolved)=self.apply_effect(s,&Effect::Draw {target:target.clone(),amount:Expr::number(r.amount as i64)})?;
                s.ability_result=s.ability_result.saturating_add(amount);s.ability_succeeded|=resolved;continue;
            }
            if matches!(effect,Effect::CreateTokenUnit {..}) {
                s.card_mut(r.token).set_hidden_qualified(true);self.add_arena(s,r.token)?;s.ability_result=s.ability_result.saturating_add(1);s.ability_succeeded=true;
                continue;
            }
            if let Effect::GainForce{..}=effect {
                let player=[Seat::P1,Seat::P2].into_iter().find(|player|s.player(*player).base==r.target).ok_or("captured Force player identity missing")?;
                if !s.force_state_exact||s.player(player).force_id==0||self.force_def.is_none(){return Err("Force requires exact reviewed identity".into());}
                if !s.player(player).force_held{s.player_mut(player).force_held=true;s.ability_result=s.ability_result.saturating_add(1);}s.ability_succeeded=true;continue;
            }
            if !self.in_arena(s,r.target)&&!self.def(s,r.target).info.is("base") { continue; }
            if r.token!=0 && matches!(effect,Effect::Damage{..}) {
                self.remove_group_shield(s,r.target,r.token);
                continue;
            }
            if r.token!=0&&matches!(effect,Effect::GiveWeakness{..}) {self.attach(s,r.token,r.target);continue;}
            if r.token!=0 {
                let experience=matches!(effect,Effect::GiveExperience{..});
                let previous=if experience { s.card(r.target).experience } else { s.card(r.target).shield };
                s.card_mut(r.token).next_token=previous;
                if experience { s.card_mut(r.target).experience=r.token; } else { s.card_mut(r.target).shield=r.token; }
                self.attach(s,r.token,r.target);
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
            if matches!(effect,Effect::Damage {..}) && amount>0 && self.in_arena(s,r.target) {damage_callbacks.push(r.target);}
            // Drain's only later primary handler changes Force presence, whose ongoing
            // effects remain cached until the engine post-event callback boundary.
            if drain&&matches!(effect,Effect::Damage{..})&&amount>0&&self.in_arena(s,r.target)&&s.card(r.target).damage>=self.hp(s,r.target){cached_lethals.push(r.target);}

            s.ability_result=s.ability_result.saturating_add(amount); s.ability_succeeded|=resolved;
        }
        let created=s.event_group.records[..s.event_group.count as usize].iter().filter(|r|matches!(&ops[r.op as usize],GroupOp::Leaf(Effect::CreateTokenUnit{..}))).map(|r|r.token).collect::<Vec<_>>();
        for source in created {
            let flags=self.effective_flags(s,source);
            for keyword in [T_SHIELD,T_AMBUSH] {
                if (keyword==T_SHIELD && flags&SHIELDED==0)||(keyword==T_AMBUSH&&flags&AMBUSH==0) {continue;}
                let n=s.death_pending.len as usize;if n==MAX_DEATH_TRIGGERS {return Err("created token trigger capacity exceeded".into());}
                s.death_pending.entries[n]=DeathTrigger {source,keyword,player:s.card(source).owner,after_pc:self.program(s.ability_program-1).event_end,defer_depth:s.death_depth,..DeathTrigger::default()};s.death_pending.len+=1;
            }
        }
        s.event_group.resolving=false;
        if drain {self.defeat_many(s,&cached_lethals)?;}
        self.finish_group_damage(s,damage_callbacks)?;
        Ok(true)
    }
    fn finish_group_damage(&self,s:&mut State,damage_callbacks:Vec<CardId>)->Result<(),String> {
        // Damage callbacks capture their lethal set in handler/selection order,
        // before any queued source defeat can change another unit's HP aura.
        let mut damage_defeats=vec![];
        for id in damage_callbacks {
            if self.in_arena(s,id) && s.card(id).damage>=self.hp(s,id) && !damage_defeats.contains(&id) {damage_defeats.push(id);}
        }
        self.check_stat_capacity(s)?; self.check_win(s);
        // Framework HP checks queue their deaths before the defeat subwindow
        // removes any pending source; a negative aura cannot rescue them mid-batch.
        let framework_dead=self.arena_units(s).into_iter()
            .filter(|id|s.card(*id).damage>=self.hp(s,*id)).collect::<Vec<_>>();
        for id in framework_dead { if !damage_defeats.contains(&id) { damage_defeats.push(id); } }
        self.defeat_many(s,&damage_defeats)?;
        self.sweep_stat_defeats(s)?;
        Ok(())
    }
    fn effect_targets(&self, s: &State, target: &Target) -> Vec<Eval> {
        let owner = s.card(s.source).owner;
        match target {
            Target::ArenaList(list)=>{
                let seat=match self.eval(s,s.source,s.ability_target,&list.receiver) {Eval::Player(seat)=>Some(seat),_=>None};
                // Snapshot candidates before modifiers and the single lethal sweep.
                // Candidate card and outer selected target retain separate bindings.
                self.arena_units(s).into_iter().filter(|id|seat.is_none_or(|seat|s.card(*id).owner==seat) && self.eval_with_card(s,s.source,s.ability_target,*id,&list.predicate).truth()).map(Eval::Card).collect()
            }
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
                "parent" if self.attached_in_play(s,s.source) => vec![Eval::Card(s.card(s.source).parent)],
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
        self.attach(s,id,target);
        Ok(())
    }
    fn effect_amount(&self, s: &State, e: &Expr) -> Result<u16, String> {
        let Eval::Number(n) = self.eval(s, s.source, s.ability_target, e) else {
            return Err("effect amount did not evaluate to an integer".into());
        };
        u16::try_from(n).map_err(|_| format!("effect amount {n} exceeds bounded runtime"))
    }
    fn resource_source_eligible(&self,s:&State,id:CardId)->bool {
        if id==0 || id!=s.source {return false;}
        let info=&self.def(s,id).info;
        if info.is("leader") || info.is("token") || !(info.is("unit")||info.is("event")||info.is("upgrade")) {return false;}
        let p=s.player(s.card(id).owner);
        p.hand.contains(id)||p.deck.contains(id)||p.discard.contains(id)||p.resources.contains(id)
    }
    fn resource_source(&self,s:&mut State,id:CardId)->Result<u16,String> {
        if !self.resource_source_eligible(s,id) {return Ok(0);}
        let owner=s.card(id).owner;
        if s.player(owner).resources.contains(id) {return Ok(0);}
        if s.player(owner).resources.len as usize>=crate::model::MAX_ZONE {return Err("resource zone capacity exceeded".into());}
        let p=s.player_mut(owner);
        p.hand.remove(id);p.deck.remove(id);p.discard.remove(id);p.resources.push(id)?;
        s.card_mut(id).exhausted=true;
        Ok(1)
    }
    fn apply_arena_keyword_batch(&self,s:&mut State,e:&Effect)->Result<(u16,bool),String> {
        if !s.arena_order_exact {return Err("arena keyword batches require recorded global arena order".into());}
        let (effects,per_recipient)=match e {Effect::PhaseModifiers{effects}=>(effects,true),Effect::Simultaneous{effects}=>(effects,false),_=>unreachable!()};
        // One phase helper carries multiple factories on each fixed recipient;
        // simultaneous helpers carry separate ordered recipient snapshots.
        let snapshots=effects.iter().map(|effect| {
            let target=match effect {Effect::GainKeyword{target,..}|Effect::LoseKeyword{target,..}=>target,_=>unreachable!()};
            self.effect_targets(s,target).into_iter().filter_map(|value|if let Eval::Card(id)=value {Some(id)}else {None}).collect::<Vec<_>>()
        }).collect::<Vec<_>>();
        let mut numeric=[[0u32;2];MAX_CARDS];
        for (index,effect) in effects.iter().enumerate() {if let Effect::GainKeyword{keyword,amount,..}=effect {
            if let Some(slot)=crate::ability_ir::CORE_KEYWORDS.iter().position(|k|k==keyword).and_then(crate::ability_ir::numeric_keyword_slot) {let amount=self.effect_amount(s,amount)? as u32;for &id in &snapshots[index] {numeric[id as usize][slot]+=amount;if s.card(id).phase_keyword_values[slot] as u32+numeric[id as usize][slot]>u16::MAX as u32 {return Err("phase keyword capacity exceeded".into());}}}
        }}
        let events=if per_recipient {snapshots[0].iter().flat_map(|id|(0..effects.len()).map(move |index|(index,*id))).collect::<Vec<_>>()}else {snapshots.iter().enumerate().flat_map(|(index,ids)|ids.iter().map(move |id|(index,*id))).collect::<Vec<_>>()};
        // Validate composed intrinsic/constant keywords and stats before publishing
        // any mutation, not merely the compact phase slots.
        let mut prospective=*s;let work=&mut prospective;
        let previous_group=work.event_group;let previous_target=work.ability_target;work.event_group.active=true;work.event_group.resolving=true;
        let mut result=0u16;let mut succeeded=false;
        for (index,id) in events {let mut effect=effects[index].clone();match &mut effect {Effect::GainKeyword{target,..}|Effect::LoseKeyword{target,..}=>*target=Target::Name("chosen".into()),_=>unreachable!()};work.event_group.context=Selection::one(id);work.ability_target=id;let (amount,resolved)=self.apply_effect(work,&effect)?;result=result.saturating_add(amount);succeeded|=resolved;}
        work.event_group=previous_group;work.ability_target=previous_target;
        self.check_stat_capacity(work)?;self.check_win(work);self.sweep_stat_defeats(work)?;
        *s=prospective;
        Ok((result,succeeded))
    }
    fn apply_effect(&self, s: &mut State, e: &Effect) -> Result<(u16, bool), String> {
        if matches!(e,Effect::PhaseModifiers{effects}|Effect::Simultaneous{effects} if effects.len()==2&&effects.iter().all(|e|matches!(e,Effect::GainKeyword{target:Target::ArenaList(_),..}|Effect::LoseKeyword{target:Target::ArenaList(_),..}))) {return self.apply_arena_keyword_batch(s,e);}

        if let Effect::Defeat {target:Target::ArenaList(_)}=e {
            if !s.arena_order_exact {return Err("arena-list defeat requires recorded global arena order".into());}
            // One complete event window: snapshot primary event order, capture
            // all death registrations, reverse cleanup across all parents, then
            // move every primary before the framework state sweep. No chunking
            // or persistent prepared-record buffer is needed for this shape.
            let targets=self.effect_targets(s,match e {Effect::Defeat {target}=>target,_=>unreachable!()}).into_iter().filter_map(|v|if let Eval::Card(id)=v {Some(id)}else{None}).collect::<Vec<_>>();
            self.defeat_many(s,&targets)?;
            self.sweep_stat_defeats(s)?;self.check_win(s);
            return Ok((targets.len() as u16,!targets.is_empty()));
        }
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
            | Effect::GiveWeakness {target,amount}
            | Effect::GainKeyword { target, amount, .. } => (target, self.effect_amount(s, amount)?),
            Effect::ResourceCard{target}|Effect::UseForce{target}|Effect::GainForce{target}|Effect::ReturnToHand { target } | Effect::ModifyStats { target, .. } | Effect::LoseKeyword { target, .. } => (target, 1),
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
        let mut draw_resolved = false;
        let mut resources_fully_resolved = true;
        for target in targets {
            match target {
                Eval::Card(id) if matches!(e,Effect::ResourceCard{..}) => {result=result.saturating_add(self.resource_source(s,id)?);}
                Eval::Player(player) if matches!(e,Effect::UseForce{..}|Effect::GainForce{..})=> {
                    if !s.force_state_exact || s.player(player).force_id==0 || self.force_def.is_none() {return Err("Force requires exact identity and reviewed native definition".into());}
                    let desired=matches!(e,Effect::GainForce{..});
                    if s.player(player).force_held!=desired {s.player_mut(player).force_held=desired;result+=1;}
                }
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
                    // Fatigue is a contingent of a resolved draw, even with no cards drawn.
                    draw_resolved |= amount > 0;
                    for _ in 0..amount {
                        if let Some(id) = s.player_mut(seat).deck.pop_front() {
                            s.player_mut(seat).hand.push(id)?;
                            result = result.saturating_add(1);
                        } else {
                            if !s.event_group.resolving {
                                let base = s.player(seat).base;
                                let hp=self.def(s,base).info.hp.unwrap_or(30) as u16;
                                s.card_mut(base).damage = s.card(base).damage.saturating_add(3).min(hp);
                            }
                        }
                    }
                }
                Eval::Card(id)
                    if id != 0
                        && (self.in_arena(s, id)
                            || self.def(s, id).info.is("base")
                            || (matches!(e,Effect::Defeat {..}|Effect::ReturnToHand {..}) && self.attached_in_play(s,id))
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
                            // Attachments are not arena unit-list members. Their
                            // links/stat grants must depart before host death checks.
                            if self.attached_in_play(s,id) {
                                self.leave_play_primary_to_discard(s,id,false)?;
                            } else if in_arena {
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
                            if let Some(slot) = crate::ability_ir::numeric_keyword_slot(index) { s.card_mut(id).phase_keyword_values[slot] = s.card(id).phase_keyword_values[slot].checked_add(amount).ok_or("phase keyword capacity exceeded")?; }
                            s.card_mut(id).add_phase_keyword(index);
                            result += 1;
                        }
                        Effect::LoseKeyword { keyword, .. } if in_arena => {
                            let index = crate::ability_ir::CORE_KEYWORDS.iter().position(|k| k == keyword).unwrap();
                            s.card_mut(id).add_lost_keyword(index);
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
                        Effect::Defeat { .. } if in_arena || self.attached_in_play(s,id) => {
                            if !s.event_group.resolving {self.capture_explicit_death(s,id)?;}
                            self.leave_play(s,id)?;
                            result += 1;
                        }
                        Effect::GiveWeakness{..} if in_arena => {
                            if amount!=1 {return Err("Weakness amount must be one".into());}
                            let def=self.weakness_def.ok_or("catalogue needs Weakness token")?;
                            if s.next_id as usize>=MAX_CARDS {return Err("card capacity exceeded creating Weakness".into());}
                            let token=s.next_id;s.next_id+=1;
                            *s.card_mut(token)=Card{present:true,def,owner:s.card(id).owner,..Card::default()};
                            self.attach(s,token,id);result+=1;
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
                result > 0 || replacement_resolved || draw_resolved
            },
        ))
    }
    pub(super) fn apply_ability_action(&self, s: &State, a: &Action) -> Result<State, String> {
        let mut t = *s;
        match s.decision {
            Decision::AbilityDiscard => {
                let count=t.event_group.discard_count;
                if count==1 {t.event_group.picks=Selection::one(a.id().ok_or("discard card missing")?);}
                else if a.kind=="card" {t.event_group.picks.toggle(a.id().ok_or("discard card missing")?)?;return Ok(t);}
                if t.event_group.picks.len!=count {return Err("discard selection must match required count".into());}
                let op=t.event_group.pc;
                for id in t.event_group.picks.ids[..count as usize].to_vec() {
                    let n=t.event_group.count as usize;if n==32 {return Err("prepared discard event capacity exceeded".into());}
                    t.event_group.records[n]=PreparedEvent {op,target:id,amount:1,..PreparedEvent::default()};t.event_group.count+=1;
                }
                t.event_group.picks=Selection::default();t.event_group.discard_count=0;t.event_group.discard_owner=Seat::P1;
                t.active=t.event_group.initiator;t.event_group.pc+=1;self.run_program(&mut t)?;
            }
            Decision::DeathPlayer => {t.death_window.player=if a.arg.as_ref().and_then(Value::as_u64)==Some(0){s.active}else{s.active.other()};t.death_window.player_chosen=true;self.process_deaths(&mut t)?;}
            Decision::DeathOrder => {let i=a.arg.as_ref().and_then(Value::as_str).ok_or("death index missing")?.parse::<usize>().map_err(|_|"invalid death index")?;let groups=self.death_groups(s);self.choose_death_group(&mut t,groups.get(i).ok_or("invalid death group")?)?;}
            Decision::DeathBatch => {t.death_window.resolve_all=a.arg.as_ref().and_then(Value::as_str)==Some("all");let i=t.death_window.entries[..t.death_window.len as usize].iter().position(|e|e.player==t.active && self.batch_member(&t,*e)).ok_or("missing death batch")?;self.resolve_death(&mut t,i)?;}
            Decision::AbilityGroupShield => {
                if s.event_group.shield_count==0 {
                    let seat=if a.arg.as_ref().and_then(Value::as_u64)==Some(0) { s.active } else { s.active.other() };
                    t.event_group.shield_priority=seat.index() as u8+1;
                } else {
                    let effect=self.program(s.ability_program-1).instructions[s.ability_pc as usize].group_effect().expect("group replacement instruction");
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
                        let picks=if nested.is_some(){t.event_group.picks}else{t.ability_selection};
                        let id=a.id().unwrap();
                        if !picks.ids[..picks.len as usize].contains(&id)&&picks.len as usize>=r.max_targets()? {return Err("selection exceeds resolver count".into());}

                        if nested.is_some() { t.event_group.picks.toggle(a.id().unwrap())?; }
                        else { t.ability_selection.toggle(a.id().unwrap())?; }
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
    /// Capture standard self-defeat registrations while the source is still in play.
    fn capture_explicit_death(&self,s:&mut State,id:CardId)->Result<(),String> {
        let start=s.death_pending.len as usize;self.capture_death(s,id)?;
        if s.ability_program!=0 {
            let end=self.program(s.ability_program-1).event_end;
            for entry in &mut s.death_pending.entries[start..] {if entry.source==0 {break;}entry.after_pc=end;entry.defer_depth=s.death_depth;}
        }
        Ok(())
    }
    pub(super) fn capture_death(&self,s:&mut State,id:CardId)->Result<(),String> {
        if self.catalogue.is_none() || !self.in_arena(s,id) {return Ok(());}
        let mut context=*s; context.active=s.card(id).owner; context.source=id;
        for &program in self.card_programs(s,id) {
            let p=self.program(program);
            if p.trigger!="whenDefeated" || p.condition.as_ref().is_some_and(|e|!self.eval(&context,id,0,e).truth()) {continue;}
            let n=s.death_pending.len as usize;
            if n==MAX_DEATH_TRIGGERS {return Err("defeat trigger capacity exceeded (64)".into());}
            s.death_pending.entries[n]=DeathTrigger {source:id,program,player:s.card(id).owner,after_pc:if s.ability_program!=0 {self.program(s.ability_program-1).event_end}else{0},defer_depth:s.death_depth,keyword:0};
            s.death_pending.len+=1;
        }
        Ok(())
    }
    /// Suspend only at an event boundary; movement and the complete lethal set settle first.
    pub(super) fn open_deaths(&self,s:&mut State,resume:u8)->Result<bool,String> {
        let ready=|e:&DeathTrigger|e.after_pc==0 || (e.defer_depth==s.death_depth && e.after_pc==s.ability_pc && s.ability_program!=0);
        if !s.death_pending.entries[..s.death_pending.len as usize].iter().any(ready) {return Ok(false);}
        if s.event_group!=EventGroupState::default() {return Err("defeat window opened before event group settled".into());}
        let n=s.death_depth as usize;
        if n==MAX_DEATH_DEPTH {return Err("nested defeat window capacity exceeded (8)".into());}
        s.death_frames[n]=DeathFrame {context:ResolutionContext::capture(s),window:s.death_window,resume};
        s.death_depth+=1;
        let pending=s.death_pending; s.death_window=DeathWindow::default();s.death_pending=DeathWindow::default();
        for e in &pending.entries[..pending.len as usize] {
            let w=if e.after_pc==0 || (e.defer_depth==s.death_depth-1 && e.after_pc==s.ability_pc && s.ability_program!=0) {&mut s.death_window}else{&mut s.death_pending};
            w.entries[w.len as usize]=*e;w.len+=1;
        }
        // Engine active player is the action's player, even during opponent-owned nested triggers.
        s.death_window.initiator=if n==0 {if resume==4 {s.initiative}else{s.active}}else{s.death_frames[n].window.initiator};
        s.ability_program=0;s.pending_programs=0;s.pending_triggers=0;s.event_group=EventGroupState::default();
        self.process_deaths(s)?;Ok(true)
    }
    pub(super) fn merge_enter_deaths(&self,s:&mut State)->Result<(),String> {
        if s.trigger_context!=1 || s.death_pending.len==0 || (s.pending_programs==0 && s.pending_triggers==0) {return Ok(());}
        let old=s.death_pending;let mut merged=DeathWindow::default();
        for (i,&program) in self.card_programs(s,s.source).iter().enumerate() {
            if s.pending_programs&(1<<i)==0 {continue;}
            let n=merged.len as usize;if n==MAX_DEATH_TRIGGERS {return Err("merged trigger window capacity exceeded".into());}
            merged.entries[n]=DeathTrigger {source:s.source,program,player:s.active,..DeathTrigger::default()};merged.len+=1;
        }
        for keyword in self.trigger_bits(s) {
            let n=merged.len as usize;if n==MAX_DEATH_TRIGGERS {return Err("merged trigger window capacity exceeded".into());}
            merged.entries[n]=DeathTrigger {source:s.source,keyword,player:s.active,..DeathTrigger::default()};merged.len+=1;
        }
        for e in &old.entries[..old.len as usize] {let n=merged.len as usize;if n==MAX_DEATH_TRIGGERS {return Err("merged trigger window capacity exceeded".into());}merged.entries[n]=*e;merged.len+=1;}
        s.death_pending=merged;s.pending_programs=0;s.pending_triggers=0;Ok(())
    }
    /// Capture one declaration window before either player's effects resolve.
    /// Existing source-only attack protocol stays intact without defender triggers.
    pub(super) fn has_defense_registration(&self,s:&State,id:CardId)->bool {
        self.catalogue.is_some() && self.card_programs(s,id).iter().any(|p|self.program(*p).trigger=="onDefense")
    }
    pub(super) fn capture_defense_window(&self,s:&mut State,declaration:&State)->Result<bool,String> {
        if self.catalogue.is_none() || !self.in_arena(declaration,declaration.attack_defender) {return Ok(false);}
        let defender=declaration.attack_defender;
        let programs:Vec<_>=self.card_programs(declaration,defender).iter().copied().filter(|p| {let p=self.program(*p);p.trigger=="onDefense" && p.condition.as_ref().is_none_or(|condition|self.eval(declaration,defender,0,condition).truth())}).collect();
        if programs.is_empty() {return Ok(false);}
        let mut registration=*declaration;
        registration.pending_triggers=0;registration.attack_restore=self.keyword_amount(&registration,registration.source,"restore");
        if self.has_keyword(&registration,registration.source,"restore") {registration.pending_triggers|=T_RESTORE;}
        if self.keyword_amount(&registration,registration.source,"saboteur")>0 && self.in_arena(&registration,defender) {registration.pending_triggers|=T_SABOTEUR;}
        self.queue_programs(&mut registration,"onAttack");s.attack_restore=registration.attack_restore;
        let mut entries=Vec::new();
        for (i,&program) in self.card_programs(&registration,registration.source).iter().enumerate() {if registration.pending_programs&(1<<i)!=0 {entries.push(DeathTrigger {source:registration.source,program,player:registration.card(registration.source).owner,..DeathTrigger::default()});}}
        for keyword in self.trigger_bits(&registration) {entries.push(DeathTrigger {source:registration.source,keyword,player:registration.card(registration.source).owner,..DeathTrigger::default()});}
        for program in programs {entries.push(DeathTrigger {source:defender,program,player:declaration.card(defender).owner,..DeathTrigger::default()});}
        // Stat deaths newly queued by setCurrentAttack belong to declaration:
        // engine framework child windows pass their triggers to that parent.
        let start=declaration.death_pending.len as usize;
        let end=s.death_pending.len as usize;
        if end<start {return Err("declaration pending trigger accounting changed".into());}
        entries.extend_from_slice(&s.death_pending.entries[start..end]);
        s.death_pending.entries[start..end].fill(DeathTrigger::default());s.death_pending.len=start as u8;
        if entries.len()>MAX_DEATH_TRIGGERS {return Err("attack declaration trigger capacity exceeded".into());}
        let n=s.death_depth as usize;if n==MAX_DEATH_DEPTH {return Err("nested attack declaration capacity exceeded".into());}
        s.pending_programs=0;s.pending_triggers=0;
        let initiator=if n==0 {s.active}else{s.death_window.initiator};
        s.death_frames[n]=DeathFrame {context:ResolutionContext::capture(s),window:s.death_window,resume:2};s.death_depth+=1;
        let mut window=DeathWindow::default();window.initiator=initiator;
        for entry in entries {let index=window.len as usize;window.entries[index]=entry;window.len+=1;}
        s.death_window=window;s.ability_program=0;
        // Prior framework deaths keep their own nested window rather than
        // becoming declaration triggers in the same player-choice menu.
        if !self.open_deaths(s,6)? {self.process_deaths(s)?;}
        Ok(true)
    }
    fn captured_trigger_context(&self,s:&State,e:DeathTrigger)->State {
        let mut context=*s;context.source=e.source;context.active=e.player;
        if e.keyword==T_SABOTEUR && context.attack_defender!=0 {context.target=context.attack_defender;}
        context
    }
    fn death_title(&self,s:&State,e:DeathTrigger,static_title:bool)->String {
        let c=self.captured_trigger_context(s,e);
        if e.keyword!=0 {let title=self.trigger_title(&c,e.keyword);if !static_title&&!self.trigger_effect(&c,e.keyword) {format!("(No effect) {title}")}else{title}}
        else if static_title {self.program(e.program).title.clone()}else{self.program_menu_title(&c,e.source,e.program)}
    }
    fn same_death_group(&self,s:&State,a:DeathTrigger,b:DeathTrigger)->bool {
        self.def(s,a.source).info.internal_name==self.def(s,b.source).info.internal_name && self.death_title(s,a,true)==self.death_title(s,b,true)
    }
    fn batch_member(&self,s:&State,e:DeathTrigger)->bool {self.same_death_group(s,e,DeathTrigger {source:s.death_window.group_source,program:s.death_window.group_program,keyword:s.death_window.group_keyword,player:s.active,..DeathTrigger::default()})}
    fn death_groups(&self,s:&State)->Vec<Vec<usize>> {
        let mut groups:Vec<Vec<usize>>=vec![];
        for (i,e) in s.death_window.entries[..s.death_window.len as usize].iter().enumerate() {
            if e.player!=s.death_window.player {continue;}
            if let Some(g)=groups.iter_mut().find(|g| {let first=s.death_window.entries[g[0]]; self.same_death_group(s,first,*e)}) {g.push(i);} else {groups.push(vec![i]);}
        }
        groups.sort_by_key(|g|!g.iter().any(|i|self.death_has_effect(s,s.death_window.entries[*i])));
        groups
    }
    fn death_has_effect(&self,s:&State,e:DeathTrigger)->bool {
        let context=self.captured_trigger_context(s,e);
        if e.keyword!=0 {self.trigger_effect(&context,e.keyword)}else{self.program_has_effect(&context,e.source,e.program)}
    }
    fn remove_death(&self,s:&mut State,i:usize)->DeathTrigger {
        let e=s.death_window.entries[i];let n=s.death_window.len as usize;
        s.death_window.entries.copy_within(i+1..n,i);s.death_window.len-=1;
        s.death_window.entries[n-1]=DeathTrigger::default();e
    }
    fn resolve_death(&self,s:&mut State,i:usize)->Result<(),String> {
        let e=self.remove_death(s,i);s.source=e.source;s.active=e.player;s.target=if e.keyword==T_SABOTEUR {s.attack_defender}else{0};s.trigger_context=0;
        if e.keyword!=0 {s.trigger_context=4;self.resolve_trigger(s,e.keyword)}else{self.begin_program(s,e.program,2)}
    }
    pub(super) fn process_deaths(&self,s:&mut State)->Result<(),String> {
        loop {
            if !s.death_window.player_chosen {
                // Pinned cleanup suppresses an entirely ineffective window, but
                // keeps both owner buckets when any registration can resolve.
                if !s.death_window.entries[..s.death_window.len as usize].iter().any(|e|self.death_has_effect(s,*e)) {
                    s.death_window.entries.fill(DeathTrigger::default());s.death_window.len=0;
                }
                let mask=s.death_window.entries[..s.death_window.len as usize].iter().fold(0u8,|m,e|m|(1<<e.player.index()));
                if mask==3 {s.active=s.death_window.initiator;s.decision=Decision::DeathPlayer;return Ok(());}
                s.death_window.player=if mask==2 {Seat::P2}else{Seat::P1};s.death_window.player_chosen=true;
            }
            let groups=self.death_groups(s);
            if groups.is_empty() || !groups.iter().flatten().any(|i|self.death_has_effect(s,s.death_window.entries[*i])) {
                let player=s.death_window.player;
                let mut i=0;while i<s.death_window.len as usize {if s.death_window.entries[i].player==player {self.remove_death(s,i);}else{i+=1;}}
                if s.death_window.len>0 {s.death_window.player=player.other();s.death_window.resolve_all=false;continue;}
                let n=s.death_depth as usize-1;let frame=s.death_frames[n];s.death_frames[n]=DeathFrame::default();s.death_depth-=1;
                s.death_window=frame.window;frame.context.restore(s);
                return match frame.resume {1=>self.run_program(s),2=>self.process_triggers(s),3=>self.finish(s),4=>self.advance_after_expiry(s),5=>self.combat_after_damage(s),6=>self.process_deaths(s),_=>Err("invalid defeat continuation".into())};
            }
            s.active=s.death_window.player;
            if s.death_window.resolve_all {
                if let Some(i)=groups.iter().flatten().find(|i| {let e=s.death_window.entries[**i];self.batch_member(s,e)}) {return self.resolve_death(s,*i);}
                s.death_window.resolve_all=false;
            }
            if groups.len()>1 {s.decision=Decision::DeathOrder;return Ok(());}
            self.choose_death_group(s,&groups[0])?;return Ok(());
        }
    }
    fn choose_death_group(&self,s:&mut State,g:&[usize])->Result<(),String> {
        if g.len()==1 {return self.resolve_death(s,g[0]);}
        let first=s.death_window.entries[g[0]];s.death_window.group_source=first.source;s.death_window.group_program=first.program;s.death_window.group_keyword=first.keyword;
        s.decision=Decision::DeathBatch;Ok(())
    }

    fn coordinate_active(&self,s:&State,source:CardId)->bool {
        let p=s.player(s.card(source).owner);
        self.in_arena(s,source) && p.ground.len as u16+p.space.len as u16>=3
    }
    pub(super) fn queue_programs(&self, s: &mut State, trigger: &str) {
        s.pending_programs = 0;
        if self.catalogue.is_none() {
            return;
        }
        for (i, p) in self.card_programs(s, s.source).iter().enumerate() {
            let p = self.program(*p);
            if p.trigger == trigger
                && (!p.coordinate || self.coordinate_active(s,s.source))
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
            return if s.pending_triggers==0 && s.pending_programs==0 && s.death_pending.len==0 && s.death_depth==0 {self.finish(s)} else {Ok(())};
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
            } else if self.in_arena(s,s.source) && s.attack_defender!=0 {
                // A still-legal defender can leave play before damage. The pinned
                // attack retains it and sends full Overwhelm damage to its base.
                if self.keyword_amount(s,s.source,"overwhelm")>0 {
                    let base=s.player(s.card(s.attack_defender).owner).base;
                    let amount=self.power(s,s.source,true);
                    self.damage(s,base,amount);self.check_win(s);
                }
                self.combat_after_damage(s)
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

// Generated executable code shares the executor's private event/prompt primitives.
include!(concat!(env!("OUT_DIR"), "/rules_aot.rs"));
impl Engine {
    pub fn set_rules_instrumentation(&mut self, enabled:bool) {self.rules_instrumentation=enabled;}
    pub fn set_rules_backend(&mut self, backend: RulesBackend)->Result<(),String> {
        if backend==RulesBackend::Aot {
            if let Some(c)=&self.catalogue {
                for d in &self.definitions {
                    for &index in d.programs.leader.iter().chain(&d.programs.unit).chain(&d.programs.card) {
                        if let Err(reason)=c.programs[index as usize].executable {return Err(format!("AOT backend unavailable for {} program {}: {reason}",d.code,index));}
                    }
                }
            }
        }
        self.rules_backend=backend;Ok(())
    }
    pub fn rules_backend_report(&self)->serde_json::Value {
        let programs=self.catalogue.as_ref().map(|c| c.programs.iter().enumerate().map(|(index,p)| {
            let bytes=serde_json::to_vec(p).expect("program serialization");
            let hash=format!("{:x}",Sha256::digest(&bytes));
            let dispatch=p.executable;
            serde_json::json!({"index":index,"contentHash":hash,"title":p.title,"trigger":p.trigger,"backend":if self.rules_backend==RulesBackend::Interpreter {"interpreter"} else if dispatch.is_ok() {"aot"} else {"interpreterFallback"},"fallbackReason":dispatch.err(),"canonicalProgram":p,"executedSteps":self.rules_hits.lock().expect("rules metrics lock").get(&index).copied().unwrap_or_default()})
        }).collect::<Vec<_>>()).unwrap_or_default();
        let cards=self.catalogue.as_ref().map(|c| c.cards.iter().map(|(code,p)| (code.clone(),serde_json::json!({"leader":p.leader,"unit":p.unit,"card":p.card}))).collect::<std::collections::BTreeMap<_,_>>()).unwrap_or_default();
        serde_json::json!({"cards":cards,"compiledScope":"instruction dispatch and supported direct primitive operations","sharedRuntime":["target selection and predicates","costs","registration conditions","event boundaries","constant live modifiers"],"instrumentationEnabled":self.rules_instrumentation,"sourceHash":format!("{:x}",Sha256::digest(include_bytes!(concat!(env!("OUT_DIR"),"/rules_aot.rs")))),"generatorAbi":"direct-primitives/v1","executionCounterOrder":["aot","interpreter"],"schema":"swu-rules-aot/v1","mode":format!("{:?}",self.rules_backend).to_lowercase(),"programs":programs,"generatedSource":include_str!(concat!(env!("OUT_DIR"),"/rules_aot.rs"))})
    }
}
