//! Differential replay against immutable forceteki trace receipts.
//! Canonical action identity is the JSON tuple
//! [kind, stableCardIdOrNull, argOrNull, methodOrNull, label]. Distributions
//! put sorted [stableCardId, amount] pairs in arg. Duplicate keys are errors.

use crate::{Engine, Seat, State};
use flate2::read::GzDecoder;
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::File,
    io::{BufRead, BufReader},
    path::Path,
};

pub fn open_jsonl(path: &Path) -> Result<Box<dyn BufRead>, String> {
    let file = File::open(path).map_err(|e| format!("{}: {e}", path.display()))?;
    if path.extension().is_some_and(|s| s == "gz") {
        Ok(Box::new(BufReader::new(GzDecoder::new(file))))
    } else {
        Ok(Box::new(BufReader::new(file)))
    }
}

pub fn first_state(path: &Path) -> Result<Value, String> {
    for (line, record) in open_jsonl(path)?.lines().enumerate() {
        let record = record.map_err(|e| e.to_string())?;
        if record.trim().is_empty() {
            continue;
        }
        let value: Value = serde_json::from_str(&record)
            .map_err(|e| format!("{}:{}: {e}", path.display(), line + 1))?;
        if let Some(state) = value.get("fullState") {
            return Ok(state.clone());
        }
        if value.get("type").and_then(Value::as_str) == Some("state") {
            return value
                .get("state")
                .cloned()
                .ok_or_else(|| "state record is missing state".into());
        }
    }
    Err(format!(
        "{} has no complete simulator state",
        path.display()
    ))
}

fn differences(expected: &Value, actual: &Value, path: &str, out: &mut Vec<String>) {
    if expected == actual || out.len() >= 20 {
        return;
    }
    match (expected, actual) {
        (Value::Object(a), Value::Object(b)) => {
            let keys: BTreeSet<_> = a.keys().chain(b.keys()).collect();
            for key in keys {
                let p = format!("{path}.{key}");
                match (a.get(key), b.get(key)) {
                    (Some(a), Some(b)) => differences(a, b, &p, out),
                    (a, b) => out.push(format!("{p}: engine={a:?}, rust={b:?}")),
                }
            }
        }
        (Value::Array(a), Value::Array(b)) => {
            if a.len() != b.len() {
                out.push(format!(
                    "{path}.length: engine={}, rust={}",
                    a.len(),
                    b.len()
                ));
            }
            for (i, (a, b)) in a.iter().zip(b).enumerate() {
                differences(a, b, &format!("{path}[{i}]"), out);
            }
        }
        _ => out.push(format!("{path}: engine={expected}, rust={actual}")),
    }
}

pub fn compare_states(expected: &Value, actual: &Value) -> Result<(), String> {
    if expected == actual {
        return Ok(());
    }
    let mut diff = Vec::new();
    differences(expected, actual, "$", &mut diff);
    Err(format!(
        "state mismatch\ndifference:\n{}\nengine state:\n{}\nrust state:\n{}",
        diff.join("\n"),
        serde_json::to_string_pretty(expected).unwrap(),
        serde_json::to_string_pretty(actual).unwrap()
    ))
}

fn key_set<'a>(
    keys: impl Iterator<Item = &'a str>,
    source: &str,
) -> Result<BTreeSet<String>, String> {
    let mut set = BTreeSet::new();
    for key in keys {
        // Parse and reserialize so object key ordering and whitespace cannot
        // manufacture mismatches. Array order (including distribution order)
        // remains significant, as required by the canonical action contract.
        let parsed: Value = serde_json::from_str(key)
            .map_err(|e| format!("{source} malformed action key {key}: {e}"))?;
        let tuple = parsed
            .as_array()
            .ok_or_else(|| format!("{source} action key is not a tuple: {key}"))?;
        if tuple.len() != 5 {
            return Err(format!(
                "{source} action key has {} fields, expected 5: {key}",
                tuple.len()
            ));
        }
        let key = parsed.to_string();
        if !set.insert(key.clone()) {
            return Err(format!("{source} canonical action collision: {key}"));
        }
    }
    Ok(set)
}

#[derive(Default, Debug, Serialize)]
pub struct CheckResult {
    pub file: String,
    pub decisions: u64,
    pub windows: u64,
    pub winner: Option<String>,
    pub matched: bool,
}

pub fn check(engine: &Engine, path: &Path) -> Result<CheckResult, String> {
    let mut result = CheckResult {
        file: path.display().to_string(),
        ..CheckResult::default()
    };
    let mut state: Option<State> = None;
    let mut finished = false;
    let mut metadata_seen = false;
    let mut next_step: Option<u64> = None;
    let mut window_receipt: Option<u64> = None;
    for (line, record) in open_jsonl(path)?.lines().enumerate() {
        let record = record.map_err(|e| format!("{}:{}: {e}", path.display(), line + 1))?;
        if record.trim().is_empty() {
            continue;
        }
        let v: Value = serde_json::from_str(&record)
            .map_err(|e| format!("{}:{}: {e}", path.display(), line + 1))?;
        let context = format!(
            "{}:{} step {}",
            path.display(),
            line + 1,
            v.get("step").unwrap_or(&Value::Null)
        );
        let run = || -> Result<(), String> {
            if finished {
                return Err("records found after terminal result".into());
            }
            if v["type"] != "meta" {
                if !metadata_seen {
                    return Err("trace is missing initial pool metadata".into());
                }
                let step = v["step"].as_u64().ok_or("record missing integer step")?;
                if let Some(expected) = next_step {
                    if step != expected {
                        return Err(format!(
                            "noncontiguous trace: expected step {expected}, found {step}"
                        ));
                    }
                } else {
                    next_step = Some(step);
                }
            }
            match v["type"].as_str() {
                Some("meta") => {
                    if metadata_seen || state.is_some() {
                        return Err("duplicate or late metadata".into());
                    }
                    if v["schema"] != "omni-rs-trace-v1" {
                        return Err(format!("unsupported trace schema {}", v["schema"]));
                    }
                    if v["pool"]["sha256"].as_str() != Some(engine.pool_hash()) {
                        return Err(format!(
                            "pool hash mismatch: trace={}, loaded={}",
                            v["pool"]["sha256"],
                            engine.pool_hash()
                        ));
                    }
                    metadata_seen = true;
                }
                Some("state") => {
                    if window_receipt.is_some() {
                        return Err("duplicate action-window receipt".into());
                    }
                    let expected = v.get("state").ok_or("state record missing state")?;
                    let current = match state {
                        Some(s) => s,
                        None => engine.load_state(expected)?,
                    };
                    if !current.is_action_window() {
                        return Err(
                            "action-window receipt reached while Rust has a pending prompt".into(),
                        );
                    }
                    compare_states(expected, &engine.snapshot(&current))?;
                    state = Some(current);
                    window_receipt = next_step;
                    result.windows += 1;
                }
                Some("decision") => {
                    let current = state.as_mut().ok_or("decision before initial state")?;
                    let actor = Seat::parse(v["actor"].as_str().ok_or("decision missing actor")?)?;
                    engine.set_actor(current, actor)?;
                    if current.is_action_window() && window_receipt != next_step {
                        return Err(
                            "action-window decision is missing its full-state receipt".into()
                        );
                    }
                    let rust_actions = engine.legal_actions(current);
                    let rust_keys: Vec<String> = rust_actions.iter().map(|a| a.key()).collect();
                    let actual = key_set(rust_keys.iter().map(String::as_str), "rust")?;
                    let actions = v["actions"]
                        .as_array()
                        .ok_or("decision missing actions array")?;
                    let keys: Result<Vec<&str>, _> = actions
                        .iter()
                        .map(|a| {
                            a["key"]
                                .as_str()
                                .ok_or("engine action missing canonical key")
                        })
                        .collect();
                    let expected = key_set(keys?.into_iter(), "engine")?;
                    if expected != actual {
                        let missing: Vec<_> = expected.difference(&actual).collect();
                        let extra: Vec<_> = actual.difference(&expected).collect();
                        return Err(format!("legal actions mismatch\nmissing in Rust: {missing:#?}\nextra in Rust: {extra:#?}\nengine actions: {expected:#?}\nrust actions: {actual:#?}\nrust state: {}", engine.snapshot(current)));
                    }
                    if let Some(expected_window) = v["prompt"]["actionWindow"].as_bool() {
                        if expected_window != current.is_action_window() {
                            return Err("action-window flag mismatch".into());
                        }
                    }
                    let chosen = v["chosen"].as_str().ok_or("decision missing chosen key")?;
                    let canonical: Value =
                        serde_json::from_str(chosen).map_err(|e| e.to_string())?;
                    let key = canonical.to_string();
                    let selected = rust_actions
                        .iter()
                        .find(|a| a.key() == key)
                        .ok_or_else(|| format!("chosen action not legal: {key}"))?;
                    *current = engine.apply(current, selected)?;
                    result.decisions += 1;
                    next_step = next_step.map(|step| step + 1);
                    window_receipt = None;
                }
                Some("result") => {
                    let current = state.as_ref().ok_or("result before initial state")?;
                    let expected = v.get("state").ok_or("terminal result missing full state")?;
                    compare_states(expected, &engine.snapshot(current))?;
                    if !current.is_terminal() {
                        return Err("trace ended without a terminal state".into());
                    }
                    let winner = engine.snapshot(current)["winner"].clone();
                    if v["winner"] != winner {
                        return Err(format!(
                            "winner mismatch: engine={}, rust={winner}",
                            v["winner"]
                        ));
                    }
                    result.winner = winner.as_str().map(str::to_string);
                    finished = true;
                }
                kind => return Err(format!("unknown record type {kind:?}")),
            }
            Ok(())
        };
        let mut run = run;
        run().map_err(|e| format!("{context}: {e}"))?;
    }
    if !finished {
        return Err(format!(
            "{}: missing terminal result (incomplete trace)",
            path.display()
        ));
    }
    result.matched = true;
    Ok(result)
}

/// Preserve useful labels alongside each machine-readable proof result.
pub fn position_labels(value: &Value) -> BTreeMap<String, Value> {
    [
        "game",
        "seed",
        "bots",
        "i",
        "windows",
        "fromEnd",
        "round",
        "toMove",
        "winner",
        "proven",
        "proofDepth",
        "solveTried",
        "jsMs",
    ]
    .into_iter()
    .filter_map(|key| value.get(key).map(|v| (key.to_string(), v.clone())))
    .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn canonical_keys_preserve_distinct_methods_and_reject_collisions() {
        let a = r#"["button",null,"x",null,"Done"]"#;
        let b = r#"["button",null,"x","resolve","Done"]"#;
        assert_eq!(key_set([a, b].into_iter(), "fixture").unwrap().len(), 2);
        assert!(key_set([a, a].into_iter(), "fixture")
            .unwrap_err()
            .contains("collision"));
    }
    #[test]
    fn state_differences_include_nested_deck_order_and_fields() {
        let error = compare_states(
            &json!({"players":{"p1":{"deck":["a","b"]}}}),
            &json!({"players":{"p1":{"deck":["b","a"]}}}),
        )
        .unwrap_err();
        assert!(error.contains("$.players.p1.deck[0]"));
    }
}
