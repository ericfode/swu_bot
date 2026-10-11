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

struct References {
    seen: HashMap<String, String>,
    next: u64,
}

impl References {
    fn card<'a>(&mut self, v: &'a Value, at: &str) -> Result<(&'a str, &'static Value), String> {
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
        let info = catalogue()
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
        ],
        "state",
    )?;
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
            ],
            seat,
        )?;
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
        if !has_type(base_info, "base") || number(base, "hp", 30, "base")? != 30 {
            return Err(format!("{seat}.base must be a plain 30 HP base"));
        }
        dead[seat_index] = number(base, "damage", u16::MAX as u64, "base")? >= 30;
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
                    if !has_type(info, "unit") || has_type(info, "token") {
                        return Err(format!("{at}: expected a nonleader unit"));
                    }
                    info
                };
                if zone == "resources" {
                    boolean(c, "exhausted", &at)?;
                }
                if arena {
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
                    if upgrades.len() > 1 {
                        return Err(format!("{at}: multiple upgrades unsupported"));
                    }
                    for u in upgrades {
                        fields(
                            u,
                            &["id", "setCode", "name", "token"],
                            &format!("{at}.upgrades"),
                        )?;
                        let (_, info) = refs.card(u, &format!("{at}.upgrades"))?;
                        if info["setCode"] != "TOKEN_SHIELD" || !boolean(u, "token", "upgrade")? {
                            return Err(format!("{at}: only Shield tokens are supported"));
                        }
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
