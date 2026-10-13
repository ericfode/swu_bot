//! Fail-closed import boundary. Proofs must never silently discard unknown rules
//! state or truncate JSON numbers into the compact representation.
use crate::model::{MAX_CARDS, MAX_ZONE};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    sync::OnceLock,
};

fn catalogue() -> &'static HashMap<String, Value> {
    static CARDS: OnceLock<HashMap<String, Value>> = OnceLock::new();
    CARDS.get_or_init(|| {
        let pool: Value = serde_json::from_str(include_str!("../../omni/rs/pool.json"))
            .expect("committed pool is valid JSON");
        pool["cards"]
            .as_array()
            .expect("committed pool has cards")
            .iter()
            .map(|c| (c["setCode"].as_str().unwrap().to_owned(), c.clone()))
            .collect()
    })
}

fn number(v: &Value, key: &str, max: u64, at: &str) -> Result<u64, String> {
    v[key]
        .as_u64()
        .filter(|&n| n <= max)
        .ok_or_else(|| format!("{at}.{key}: expected integer in 0..={max}"))
}

fn boolean(v: &Value, key: &str, at: &str) -> Result<bool, String> {
    v[key]
        .as_bool()
        .ok_or_else(|| format!("{at}.{key}: expected boolean"))
}

fn fields(v: &Value, allowed: &[&str], at: &str) -> Result<(), String> {
    let object = v
        .as_object()
        .ok_or_else(|| format!("{at}: expected object"))?;
    for key in object.keys() {
        if !allowed.contains(&key.as_str()) {
            return Err(format!("unsupported state field {at}.{key}"));
        }
    }
    Ok(())
}

pub fn validate_pool(v: &Value) -> Result<(), String> {
    if v["schema"] != "omni-rs-pool-v1" {
        return Err("unsupported pool schema".into());
    }
    let cards = v["cards"].as_array().ok_or("pool.cards must be an array")?;
    let mut seen = HashSet::new();
    for c in cards {
        let code = c["setCode"].as_str().ok_or("pool card missing setCode")?;
        let name = c["internalName"].as_str().unwrap_or("unnamed");
        let approved = catalogue().get(code).ok_or_else(|| {
            format!("unsupported card {name} ({code}): not in the compiled subset")
        })?;
        if !seen.insert(code) {
            return Err(format!("duplicate pool card {name} ({code})"));
        }
        // Descriptive reasons and the pool's ordering may change without changing rules.
        // Every rules-bearing property must match the implemented, versioned catalogue.
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
            if c[field] != approved[field] {
                return Err(format!("unsupported card {name} ({code}): {field} differs from the implemented catalogue"));
            }
        }
    }
    Ok(())
}

struct References<'a> {
    catalogue: &'a HashMap<String, Value>,
    seen: HashMap<String, String>,
    next: u64,
}

impl<'a> References<'a> {
    fn card<'v>(&mut self, v: &'v Value, at: &str) -> Result<(&'v str, &'a Value), String> {
        let id = v["id"]
            .as_str()
            .ok_or_else(|| format!("{at}: missing card id"))?;
        let index = id
            .strip_prefix('c')
            .and_then(|s| s.parse::<u64>().ok())
            .filter(|n| format!("c{n}") == id && *n < self.next)
            .ok_or_else(|| {
                format!(
                    "{at}: invalid stable card id {id:?} for nextCardId {}",
                    self.next
                )
            })?;
        if index + 1 >= MAX_CARDS as u64 {
            return Err(format!("{at}: card capacity exceeded"));
        }
        if let Some(prior) = self.seen.insert(id.to_owned(), at.to_owned()) {
            return Err(format!("duplicate card {id} at {prior} and {at}"));
        }
        let code = v["setCode"]
            .as_str()
            .ok_or_else(|| format!("{at}: missing setCode"))?;
        let info = self
            .catalogue
            .get(code)
            .ok_or_else(|| format!("unsupported card {} ({code})", v["name"]))?;
        if v["name"] != info["internalName"] {
            return Err(format!("{at}: card {id} name does not match {code}"));
        }
        Ok((id, info))
    }
}

fn has_type(info: &Value, kind: &str) -> bool {
    info["types"]
        .as_array()
        .is_some_and(|ts| ts.iter().any(|t| t == kind))
}

pub fn validate_state(v: &Value) -> Result<(), String> {
    validate_state_with_catalogue(v, catalogue())
}

/// Validate a snapshot against the card definitions already accepted by its
/// engine. This checks state shape and references, not ability implementation;
/// callers must validate a supplied catalogue before constructing their engine.
pub fn validate_state_with_catalogue(
    v: &Value,
    catalogue: &HashMap<String, Value>,
) -> Result<(), String> {
    fields(
        v,
        &[
            "nextCardId",
            "round",
            "phase",
            "initiative",
            "initiativeClaimed",
            "prevPassed",
            "activePlayer",
            "actor",
            "winner",
            "players",
            "arenaUnitOrder",
            "hiddenHistoryVersion",
            "forceStateVersion",
        ],
        "state",
    )?;
    let history = match v.get("hiddenHistoryVersion") {None=>false,Some(n) if n.as_u64()==Some(1)=>true,_=>return Err("unsupported hiddenHistoryVersion".into())};
    let force_exact = match v.get("forceStateVersion") {None=>false,Some(n) if n.as_u64()==Some(1)=>true,_=>return Err("unsupported forceStateVersion".into())};
    let next = number(v, "nextCardId", (MAX_CARDS - 1) as u64, "state")?;
    if number(v, "round", u16::MAX as u64, "state")? == 0 {
        return Err("state.round must be positive".into());
    }
    if v["phase"] != "action" {
        return Err("positions must start in the action phase".into());
    }
    let initiative = v["initiative"]
        .as_str()
        .filter(|s| ["p1", "p2"].contains(s))
        .ok_or("invalid initiative")?;
    boolean(v, "initiativeClaimed", "state")?;
    boolean(v, "prevPassed", "state")?;
    if !v
        .get("winner")
        .is_some_and(|w| w.is_null() || matches!(w.as_str(), Some("p1" | "p2" | "draw")))
    {
        return Err("winner must be null, p1, p2, or draw".into());
    }
    let terminal = !v["winner"].is_null();
    if !terminal {
        let actor = v["actor"]
            .as_str()
            .filter(|s| ["p1", "p2"].contains(s))
            .ok_or("nonterminal action-window state needs actor")?;
        if v["activePlayer"] != actor {
            return Err("actor differs from activePlayer at action window".into());
        }
    }
    fields(&v["players"], &["p1", "p2"], "players")?;
    let mut refs = References {
        catalogue,
        seen: HashMap::new(),
        next,
    };
    let mut dead = [false; 2];
    for (seat_index, seat) in ["p1", "p2"].iter().enumerate() {
        let p = &v["players"][seat];
        fields(
            p,
            &[
                "base",
                "leader",
                "hand",
                "deck",
                "resources",
                "discard",
                "ground",
                "space",
                "out",
                "forceToken",
            ],
            seat,
        )?;
        if force_exact {
            let token=&p["forceToken"];
            fields(token,&["id","held"],"forceToken")?;
            let held=boolean(token,"held","forceToken")?;
            let id=token["id"].as_str().ok_or("Force identity missing")?;
            id.strip_prefix('c').and_then(|n|n.parse::<u64>().ok()).filter(|n|format!("c{n}")==id && *n<next && *n+1<MAX_CARDS as u64).ok_or("invalid Force stable identity")?;
            if refs.seen.insert(id.to_owned(),format!("{seat}.forceToken")).is_some(){return Err("duplicate Force identity".into());}
            if held && !catalogue.contains_key("TOKEN_THE_FORCE"){return Err("held Force requires selected native definition".into());}
        } else if p.get("forceToken").is_some(){return Err("Force identity requires forceStateVersion".into());}
        let out = boolean(p, "out", seat)?;
        if !terminal && v["actor"] == *seat && out {
            return Err(format!("{seat} cannot act after leaving the phase"));
        }
        if !terminal && out != (v["initiativeClaimed"] == true && initiative == *seat) {
            return Err(format!(
                "{seat}.out disagrees with the claimed initiative at an action window"
            ));
        }
        if v["initiativeClaimed"] == true && initiative == *seat && !out {
            return Err("initiative claimant must be out for the phase".into());
        }
        let base = &p["base"];
        fields(
            base,
            &["id", "setCode", "name", "damage", "hp", "epicUsed"],
            &format!("{seat}.base"),
        )?;
        let (_, base_info) = refs.card(base, &format!("{seat}.base"))?;
        let base_hp = number(base, "hp", 1000, "base")?;
        if !has_type(base_info, "base") || base_hp == 0 || base_info["hp"].as_u64() != Some(base_hp)
        {
            return Err(format!("{seat}.base HP must match admitted base metadata"));
        }
        dead[seat_index] = number(base, "damage", u16::MAX as u64, "base")? >= base_hp;
        if boolean(base, "epicUsed", "base")? {
            return Err("plain base cannot have a spent epic action".into());
        }
        let leader = &p["leader"];
        fields(
            leader,
            &["id", "setCode", "name", "deployed", "exhausted", "epicUsed"],
            &format!("{seat}.leader"),
        )?;
        let (leader_id, leader_info) = refs.card(leader, &format!("{seat}.leader"))?;
        if !has_type(leader_info, "leader") {
            return Err(format!("{seat}.leader is not a leader"));
        }
        let deployed = boolean(leader, "deployed", "leader")?;
        let exhausted = boolean(leader, "exhausted", "leader")?;
        let epic = boolean(leader, "epicUsed", "leader")?;
        if deployed && !epic {
            return Err("deployed leader must have spent its epic action".into());
        }
        let mut leader_in_arena = false;
        let mut unique_units = HashSet::new();
        for zone in ["hand", "deck", "resources", "discard", "ground", "space"] {
            let array = p[zone]
                .as_array()
                .ok_or_else(|| format!("{seat}.{zone}: expected array"))?;
            if array.len() > MAX_ZONE {
                return Err(format!("{seat}.{zone}: zone capacity exceeded"));
            }
            for (i, c) in array.iter().enumerate() {
                let at = format!("{seat}.{zone}[{i}]");
                let arena = zone == "ground" || zone == "space";
                let allowed: &[&str] = if arena {
                    &[
                        "id",
                        "setCode",
                        "name",
                        "damage",
                        "exhausted",
                        "power",
                        "hp",
                        "upgrades",
                        "phaseStats",
                        "phaseKeywords",
                        "phaseLostKeywords",
                        "hiddenQualified",
                    ]
                } else if zone == "resources" {
                    &["id", "setCode", "name", "exhausted"]
                } else {
                    &["id", "setCode", "name"]
                };
                fields(c, allowed, &at)?;
                // A deployed leader is intentionally represented both as leader metadata
                // and as one arena unit. This is the only permitted repeated identity.
                let info = if c["id"] == leader_id {
                    if !arena || !deployed || leader_in_arena {
                        return Err(format!("invalid repeated leader {leader_id} at {at}"));
                    }
                    if c["setCode"] != leader["setCode"]
                        || c["name"] != leader["name"]
                        || c["exhausted"] != exhausted
                    {
                        return Err(format!("conflicting deployed leader metadata at {at}"));
                    }
                    leader_in_arena = true;
                    leader_info
                } else {
                    let (_, info) = refs.card(c, &at)?;
                    if (has_type(info, "token") && (!arena || !has_type(info,"unit") || has_type(info,"upgrade")))
                        || has_type(info, "leader")
                        || has_type(info, "base")
                        || !(has_type(info, "unit") || (!arena && (has_type(info, "event") || has_type(info,"upgrade"))))
                    {
                        return Err(format!(
                            "{at}: expected a nonleader unit{}",
                            if arena { "" } else { " or event" }
                        ));
                    }
                    info
                };
                if zone == "resources" {
                    boolean(c, "exhausted", &at)?;
                }
                if arena {
                    if history {boolean(c,"hiddenQualified",&at)?;} else if c.get("hiddenQualified").is_some() {return Err(format!("{at}: hiddenQualified requires hiddenHistoryVersion"));}
                    if info["arena"] != zone {
                        return Err(format!("{at}: card is in the wrong arena"));
                    }
                    if !terminal
                        && info["unique"] == true
                        && !unique_units.insert(info["internalName"].as_str().unwrap())
                    {
                        return Err(format!(
                            "{at}: unresolved unique rule for {} at action window",
                            info["internalName"]
                        ));
                    }
                    let hp = number(c, "hp", u16::MAX as u64, &at)?;
                    if hp == 0 {
                        return Err(format!("{at}: unit HP must be positive"));
                    }
                    let damage = number(c, "damage", u16::MAX as u64, &at)?;
                    if !terminal && damage >= hp {
                        return Err(format!("{at}: defeated unit left in arena"));
                    }
                    boolean(c, "exhausted", &at)?;
                    number(c, "power", u16::MAX as u64, &at)?;
                    let upgrades = c["upgrades"]
                        .as_array()
                        .ok_or_else(|| format!("{at}: upgrades must be an array"))?;
                    if upgrades.len() >= MAX_CARDS {
                        return Err(format!("{at}: upgrade capacity exceeded"));
                    }
                    let mut upgrade_stats=(0i64,0i64);
                    for u in upgrades {
                        fields(
                            u,
                            &["id", "setCode", "name", "token", "controller", "owner"],
                            &format!("{at}.upgrades"),
                        )?;
                        let (_, info) = refs.card(u, &format!("{at}.upgrades"))?;
                        if !has_type(info,"upgrade") {return Err(format!("{at}: attachment must be an upgrade"));}
                        let token=boolean(u,"token","upgrade")?;
                        if token {
                            if !matches!(u["setCode"].as_str(),Some("TOKEN_SHIELD"|"TOKEN_EXPERIENCE"|"TOKEN_WEAKNESS")) || !has_type(info,"token") {return Err(format!("{at}: only Shield, Experience and Weakness tokens are supported"));}
                            if u["setCode"]=="TOKEN_WEAKNESS" {upgrade_stats.0+=info["upgradePower"].as_i64().ok_or("Weakness missing signed power")?;upgrade_stats.1+=info["upgradeHp"].as_i64().ok_or("Weakness missing signed HP")?;}
                        }else{
                            if has_type(info,"token") {return Err(format!("{at}: only Shield, Experience and Weakness tokens are supported"));}
                            let controller=u["controller"].as_str().ok_or("ordinary upgrade needs controller")?;
                            let owner=u["owner"].as_str().ok_or("ordinary upgrade needs owner")?;
                            if owner!=controller {return Err("foreign-controlled upgrade imports are unsupported".into());}
                            upgrade_stats.0+=info["upgradePower"].as_i64().unwrap_or(0);upgrade_stats.1+=info["upgradeHp"].as_i64().unwrap_or(0);
                            if !["p1","p2"].contains(&controller) || u["owner"].as_str().is_some_and(|owner|owner!=controller) {return Err("foreign-controlled upgrade imports are unsupported".into());}
                        }
                    }
                    if let Some(keywords) = c.get("phaseKeywords") {
                        let object = keywords.as_object().ok_or_else(|| format!("{at}: phaseKeywords must be object"))?;
                        for (keyword, amount) in object {
                            if keyword=="hidden" && !history {return Err(format!("{at}: Hidden phase effect requires explicit history"));}
                            let index = crate::ability_ir::CORE_KEYWORDS.iter().position(|k| k == keyword).ok_or_else(|| format!("{at}: unknown phase keyword {keyword}"))?;
                            let amount = amount.as_u64().filter(|n| *n <= 65535).ok_or_else(|| format!("{at}: invalid phase keyword amount"))?;
                            if crate::ability_ir::numeric_keyword_slot(index).is_none() && amount != 1 { return Err(format!("{at}: boolean phase keyword amount must be one")); }
                            if keyword == "restore" && amount == 0 { return Err(format!("{at}: zero phase Restore requires verified nullable trigger titles")); }
                        }
                    }
                    if let Some(keywords) = c.get("phaseLostKeywords") {
                        let array = keywords.as_array().ok_or_else(|| format!("{at}: phaseLostKeywords must be array"))?;
                        let mut seen = HashSet::new();
                        for keyword in array {
                            let name = keyword.as_str().filter(|k| crate::ability_ir::CORE_KEYWORDS.contains(k)).ok_or_else(|| format!("{at}: unknown lost phase keyword"))?;
                            if name=="hidden" && !history {return Err(format!("{at}: Hidden phase loss requires explicit history"));}
                            if !seen.insert(name) { return Err(format!("{at}: duplicate lost phase keyword")); }
                        }
                    }
                    let phase = if let Some(stats) = c.get("phaseStats") {
                        fields(stats, &["power", "hp"], &format!("{at}.phaseStats"))?;
                        let power = stats["power"]
                            .as_i64()
                            .filter(|n| (-65535..=65535).contains(n))
                            .ok_or_else(|| format!("{at}: phase power out of range"))?;
                        let hp = stats["hp"]
                            .as_i64()
                            .filter(|n| (-65535..=65535).contains(n))
                            .ok_or_else(|| format!("{at}: phase HP out of range"))?;
                        (power, hp)
                    } else {
                        (0, 0)
                    };
                    // Validate composed stat capacity before the compact engine
                    // calculates it. Terminal snapshots may retain a defeated
                    // Grit unit, so damage need not be below its printed HP.
                    let experience = upgrades
                        .iter()
                        .filter(|u| u["setCode"] == "TOKEN_EXPERIENCE")
                        .count() as u64;
                    let printed_grit = info["keywords"].as_array().is_some_and(|ks| ks.iter().any(|k| k == "grit"))
                        && [info["text"].as_str(), has_type(info, "leader").then(|| info["deployBox"].as_str()).flatten()].into_iter().flatten().any(|text| text.lines().any(|line| line.starts_with("Grit")));
                    let grit = c["phaseKeywords"]["grit"] == 1 || printed_grit;
                    let power = info["power"].as_i64().unwrap_or(0)
                        + experience as i64 + upgrade_stats.0
                        + if grit && !c["phaseLostKeywords"].as_array().is_some_and(|ks| ks.iter().any(|k| k == "grit")) { damage as i64 } else { 0 }
                        + phase.0;
                    let hp = info["hp"].as_i64().unwrap_or(0) + experience as i64 + phase.1 + upgrade_stats.1;
                    if power > u16::MAX as i64 {
                        return Err(format!(
                            "{at}: computed power exceeds compact state capacity"
                        ));
                    }
                    if hp > u16::MAX as i64 {
                        return Err(format!("{at}: computed HP exceeds compact state capacity"));
                    }
                }
            }
        }
        if deployed != leader_in_arena {
            return Err(format!("{seat}: deployed leader missing from arena"));
        }
    }
    // The engine latches the first result and finishes the current action's events.
    // Later events may destroy the other base without replacing that winner.
    let consistent = match v["winner"].as_str() {
        Some("p1") => dead[1],
        Some("p2") => dead[0],
        Some("draw") => dead == [true, true],
        None => dead == [false, false],
        _ => false,
    };
    if !consistent {
        return Err("winner disagrees with base damage".into());
    }
    validate_arena_unit_order(v,catalogue)?;
    Ok(())
}

fn validate_arena_unit_order(v:&Value,catalogue:&HashMap<String,Value>)->Result<(),String> {
    fn ordinary(value:&Value,catalogue:&HashMap<String,Value>)->bool {
        value["setCode"].as_str().and_then(|code|catalogue.get(code)).is_some_and(|info|has_type(info,"upgrade")&&!has_type(info,"token")) || match value {Value::Array(items)=>items.iter().any(|v|ordinary(v,catalogue)),Value::Object(fields)=>fields.values().any(|v|ordinary(v,catalogue)),_=>false}
    }
    let Some(order)=v.get("arenaUnitOrder") else {
        if ordinary(v,catalogue) {return Err("ordinary upgrade imports require explicit arenaUnitOrder, including future upgrades in hidden zones".into());}
        return Ok(());
    };
    let object=order.as_object().ok_or("arenaUnitOrder must be an object")?;
    if object.len()!=2 || !object.contains_key("ground") || !object.contains_key("space") {return Err("arenaUnitOrder must contain ground and space only".into());}
    for name in ["ground","space"] {
        let expected=["p1","p2"].into_iter().flat_map(|seat|v["players"][seat][name].as_array().unwrap()).map(|c|c["id"].as_str().unwrap()).collect::<HashSet<_>>();
        let actual=order[name].as_array().ok_or("arenaUnitOrder arena must be an array")?.iter().map(|id|id.as_str().ok_or("arenaUnitOrder needs stable card IDs")).collect::<Result<Vec<_>,_>>()?;
        let seen=actual.iter().copied().collect::<HashSet<_>>();
        if seen.len()!=actual.len() || seen!=expected {return Err("arenaUnitOrder must contain each arena unit exactly once with no foreign/wrong-arena cards".into());}
        for seat in ["p1","p2"] {
            let own=v["players"][seat][name].as_array().unwrap().iter().map(|c|c["id"].as_str().unwrap()).collect::<Vec<_>>();
            if actual.iter().copied().filter(|id|own.contains(id)).collect::<Vec<_>>()!=own {return Err("arenaUnitOrder conflicts with controller arena subsequence".into());}
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn pool() -> Value {
        serde_json::from_str(include_str!("../../omni/rs/pool.json")).unwrap()
    }
    fn initial_state() -> Value {
        crate::check::first_state(
            &std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures/random-vs-random-1.jsonl.gz"),
        )
        .unwrap()
    }

    #[test]
    fn complete_engine_snapshot_passes_but_missing_state_and_overflow_fail() {
        let state = initial_state();
        validate_state(&state).unwrap();
        let mut bad = state.clone();
        bad.as_object_mut().unwrap().remove("prevPassed");
        assert!(validate_state(&bad).unwrap_err().contains("prevPassed"));
        let mut bad = state.clone();
        bad["players"]["p1"]["base"]["damage"] = json!(65536);
        assert!(validate_state(&bad).unwrap_err().contains("damage"));
        let mut bad = state.clone();
        bad["winner"] = json!("p1");
        assert!(validate_state(&bad).unwrap_err().contains("winner"));
        let mut bad = state;
        bad["players"]["p1"]["force"] = json!(true);
        assert!(validate_state(&bad)
            .unwrap_err()
            .contains("unsupported state field"));
    }

    #[test]
    fn supplied_catalogue_replaces_static_catalogue_without_fallback() {
        let mut state = initial_state();
        let mut cards = catalogue().clone();
        let card = &mut state["players"]["p1"]["hand"][0];
        let old_code = card["setCode"].as_str().unwrap();
        let mut custom = cards[old_code].clone();
        custom["setCode"] = json!("CUSTOM_001");
        custom["internalName"] = json!("custom-unit");
        card["setCode"] = custom["setCode"].clone();
        card["name"] = custom["internalName"].clone();
        cards.insert("CUSTOM_001".into(), custom);

        validate_state_with_catalogue(&state, &cards).unwrap();
        assert!(validate_state(&state).unwrap_err().contains("CUSTOM_001"));

        let base_code = state["players"]["p1"]["base"]["setCode"].as_str().unwrap();
        let removed = cards.remove(base_code).unwrap();
        assert!(validate_state_with_catalogue(&state, &cards)
            .unwrap_err()
            .contains(base_code));
        cards.insert(base_code.into(), removed);
        state["players"]["p1"]["hand"][0]["name"] = json!("wrong-name");
        assert!(validate_state_with_catalogue(&state, &cards)
            .unwrap_err()
            .contains("name does not match CUSTOM_001"));
    }

    #[test]
    fn catalogue_events_are_allowed_outside_arenas() {
        let mut state = initial_state();
        let mut cards = catalogue().clone();
        let original = state["players"]["p1"]["hand"][0].clone();
        let code = original["setCode"].as_str().unwrap();
        let mut event = cards[code].clone();
        event["types"] = json!(["event"]);
        event["setCode"] = json!("CUSTOM_EVENT");
        event["internalName"] = json!("custom-event");
        cards.insert("CUSTOM_EVENT".into(), event);
        let reference =
            json!({"id":original["id"], "setCode":"CUSTOM_EVENT", "name":"custom-event"});
        state["players"]["p1"]["hand"][0] = reference.clone();
        validate_state_with_catalogue(&state, &cards).unwrap();

        state["players"]["p1"]["hand"]
            .as_array_mut()
            .unwrap()
            .remove(0);
        state["players"]["p1"]["ground"] = json!([reference]);
        assert!(validate_state_with_catalogue(&state, &cards)
            .unwrap_err()
            .contains("expected a nonleader unit"));
    }

    #[test]
    fn multiple_shield_and_experience_tokens_keep_unique_references() {
        let mut state = initial_state();
        let mut cards = catalogue().clone();
        let mut experience = cards["TOKEN_SHIELD"].clone();
        experience["setCode"] = json!("TOKEN_EXPERIENCE");
        experience["internalName"] = json!("experience");
        experience["upgradePower"] = json!(1);
        experience["upgradeHp"] = json!(1);
        cards.insert("TOKEN_EXPERIENCE".into(), experience);
        let next = state["nextCardId"].as_u64().unwrap();
        let info = &cards["IBH_003"];
        let arena = info["arena"].as_str().unwrap().to_owned();
        state["players"]["p1"][&arena] = json!([{
            "id":format!("c{next}"), "setCode":info["setCode"], "name":info["internalName"],
            "damage":0, "power":info["power"].as_u64().unwrap()+1, "hp":info["hp"].as_u64().unwrap()+1,
            "exhausted":false, "upgrades":[
                {"id":format!("c{}",next+1), "setCode":"TOKEN_SHIELD", "name":"shield", "token":true},
                {"id":format!("c{}",next+2), "setCode":"TOKEN_SHIELD", "name":"shield", "token":true},
                {"id":format!("c{}",next+3), "setCode":"TOKEN_EXPERIENCE", "name":"experience", "token":true}
            ]
        }]);
        state["nextCardId"] = json!(next + 4);
        validate_state_with_catalogue(&state, &cards).unwrap();
        assert!(validate_state(&state)
            .unwrap_err()
            .contains("TOKEN_EXPERIENCE"));

        let upgrades = &mut state["players"]["p1"][&arena][0]["upgrades"];
        upgrades[1]["id"] = upgrades[0]["id"].clone();
        assert!(validate_state_with_catalogue(&state, &cards)
            .unwrap_err()
            .contains("duplicate card"));
        let upgrades = &mut state["players"]["p1"][&arena][0]["upgrades"];
        upgrades[1]["id"] = json!(format!("c{}", next + 2));
        upgrades[2]["token"] = json!(false);
        assert!(validate_state_with_catalogue(&state, &cards)
            .unwrap_err()
            .contains("only Shield, Experience and Weakness tokens"));
    }

    #[test]
    fn conditional_grit_metadata_does_not_add_damage_to_capacity() {
        let mut cards = catalogue().clone();
        let code = "LOF_254";
        let info = cards.get_mut(code).unwrap();
        info["keywords"] = json!(["grit"]);
        info["text"] = json!("While you have the initiative, this unit gains Grit.");
        let info = info.clone();
        let mut state = initial_state();
        let next = state["nextCardId"].as_u64().unwrap();
        state["players"]["p1"][info["arena"].as_str().unwrap()] = json!([{
            "id":format!("c{next}"),"setCode":code,"name":info["internalName"],"damage":65535,"power":info["power"],"hp":info["hp"],"exhausted":false,"upgrades":[]
        }]);
        state["nextCardId"] = json!(next+1);
        state["players"]["p2"]["base"]["damage"] = json!(30);
        state["winner"] = json!("p1");
        validate_state_with_catalogue(&state, &cards).unwrap();
        cards.get_mut(code).unwrap()["text"] = json!("Grit");
        assert!(validate_state_with_catalogue(&state, &cards).unwrap_err().contains("computed power"));
    }

    #[test]
    fn terminal_grit_damage_cannot_overflow_computed_power() {
        let mut state = initial_state();
        let info = catalogue()
            .values()
            .find(|c| {
                has_type(c, "unit")
                    && c["power"].as_u64().is_some_and(|n| n > 0)
                    && c["keywords"]
                        .as_array()
                        .is_some_and(|ks| ks.iter().any(|k| k == "grit"))
            })
            .unwrap();
        let next = state["nextCardId"].as_u64().unwrap();
        state["players"]["p1"][info["arena"].as_str().unwrap()] = json!([{
            "id":format!("c{next}"), "setCode":info["setCode"], "name":info["internalName"],
            "damage":65535, "power":65535, "hp":info["hp"], "exhausted":false, "upgrades":[]
        }]);
        state["nextCardId"] = json!(next + 1);
        state["players"]["p2"]["base"]["damage"] = json!(30);
        state["winner"] = json!("p1");
        assert!(validate_state(&state)
            .unwrap_err()
            .contains("computed power"));
    }

    #[test]
    fn duplicated_zone_membership_and_reused_token_ids_fail() {
        let mut state = initial_state();
        let repeated = state["players"]["p1"]["hand"][0].clone();
        state["players"]["p1"]["discard"]
            .as_array_mut()
            .unwrap()
            .push(repeated);
        assert!(validate_state(&state)
            .unwrap_err()
            .contains("duplicate card"));
        let mut state = initial_state();
        state["nextCardId"] = json!(1);
        assert!(validate_state(&state)
            .unwrap_err()
            .contains("invalid stable card id"));
    }

    #[test]
    fn unresolved_unique_choice_is_not_an_action_window() {
        let mut state = initial_state();
        let next = state["nextCardId"].as_u64().unwrap();
        let info = &catalogue()["IBH_003"];
        assert_eq!(info["unique"], true);
        let unit = |i| {
            json!({"id":format!("c{i}"), "setCode":info["setCode"], "name":info["internalName"],
            "damage":0, "power":info["power"], "hp":info["hp"], "exhausted":true, "upgrades":[]})
        };
        state["players"]["p1"][info["arena"].as_str().unwrap()] =
            json!([unit(next), unit(next + 1)]);
        state["nextCardId"] = json!(next + 2);
        assert!(validate_state(&state)
            .unwrap_err()
            .contains("unresolved unique"));
    }

    #[test]
    fn unknown_cards_and_altered_leader_rules_are_rejected_by_name() {
        let mut p = pool();
        p["cards"][0]["setCode"] = json!("FAKE_123");
        assert!(validate_pool(&p).unwrap_err().contains("FAKE_123"));
        let mut p = pool();
        let leader = p["cards"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|c| c["setCode"] == "SOR_014")
            .unwrap();
        leader["power"] = json!(1000);
        let e = validate_pool(&p).unwrap_err();
        assert!(e.contains("SOR_014") && e.contains("power"));
    }

    #[test]
    fn pool_metadata_can_change_without_reinterpreting_card_rules() {
        let mut p = pool();
        p["description"] = json!("test subset");
        p["cards"][0]["reason"] = json!("changed rationale");
        validate_pool(&p).unwrap();
    }

    #[test]
    fn missing_negative_fractional_and_overflow_numbers_never_default_or_wrap() {
        for value in [Value::Null, json!(-1), json!(1.5), json!(65536), json!("2")] {
            assert!(number(&json!({"damage": value}), "damage", 65535, "card").is_err());
        }
        assert_eq!(
            number(&json!({"damage": 0}), "damage", 65535, "card").unwrap(),
            0
        );
    }

    #[test]
    fn duplicate_ids_and_noncanonical_ids_fail() {
        let p = pool();
        let c = &p["cards"][0];
        let mut card = json!({"id":"c0", "setCode":c["setCode"], "name":c["internalName"]});
        let mut refs = References {
            catalogue: catalogue(),
            seen: HashMap::new(),
            next: 3,
        };
        refs.card(&card, "first").unwrap();
        assert!(refs
            .card(&card, "second")
            .unwrap_err()
            .contains("duplicate"));
        card["id"] = json!("c01");
        assert!(refs
            .card(&card, "third")
            .unwrap_err()
            .contains("invalid stable"));
    }
}
