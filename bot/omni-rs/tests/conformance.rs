use omni_rs::{check, Engine};
use std::{io::BufRead, path::Path};

#[test]
fn recorded_engine_games_match_every_decision_and_window() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let engine = Engine::from_pool(&root.join("../omni/rs/pool.json")).unwrap();
    let mut fixtures = std::fs::read_dir(root.join("tests/fixtures"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.extension().is_some_and(|extension| extension == "gz"))
        .collect::<Vec<_>>();
    fixtures.sort();
    assert!(
        fixtures.len() >= 3,
        "committed engine fixtures must be present"
    );
    for path in fixtures {
        let result = check::check(&engine, &path).unwrap();
        assert!(result.matched);
        assert!(result.decisions > 0);
        assert!(result.windows > 0);
    }
}

#[test]
fn checker_rejects_missing_receipts_and_tampered_provenance() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let engine = Engine::from_pool(&root.join("../omni/rs/pool.json")).unwrap();
    let fixture = root.join("tests/fixtures/heuristic-vs-heuristic-1.jsonl.gz");
    let records: Vec<serde_json::Value> = check::open_jsonl(&fixture)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(&line.unwrap()).unwrap())
        .collect();
    let check_modified = |name: &str, altered: Vec<serde_json::Value>, expected: &str| {
        let path =
            std::env::temp_dir().join(format!("omni-rs-check-{}-{name}.jsonl", std::process::id()));
        std::fs::write(
            &path,
            altered
                .into_iter()
                .map(|v| v.to_string() + "\n")
                .collect::<String>(),
        )
        .unwrap();
        let result = check::check(&engine, &path);
        std::fs::remove_file(&path).unwrap();
        assert!(
            result.unwrap_err().contains(expected),
            "{name} should fail with {expected}"
        );
    };
    let mut changed = records.clone();
    changed[0]["pool"]["sha256"] = serde_json::json!("wrong-pool");
    check_modified("pool", changed, "pool hash mismatch");

    let mut changed = records.clone();
    let later_window = changed
        .iter()
        .enumerate()
        .skip(2)
        .find(|(_, v)| v["type"] == "state")
        .unwrap()
        .0;
    changed.remove(later_window);
    check_modified("receipt", changed, "missing its full-state receipt");

    let mut changed = records.clone();
    let decision = changed
        .iter_mut()
        .find(|v| v["type"] == "decision")
        .unwrap();
    let duplicate = decision["actions"][0].clone();
    decision["actions"].as_array_mut().unwrap().push(duplicate);
    check_modified("collision", changed, "canonical action collision");

    let mut changed = records;
    changed.pop();
    check_modified("truncated", changed, "missing terminal result");
}
