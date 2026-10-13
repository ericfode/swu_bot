use omni_rs::{check, Engine};
use sha2::{Digest, Sha256};
use std::{collections::{BTreeMap, BTreeSet}, path::Path};

fn checked_bytes(path: &Path, expected: &str) -> Vec<u8> {
    let bytes = std::fs::read(path).unwrap();
    assert_eq!(format!("{:x}", Sha256::digest(&bytes)), expected, "reference bytes changed: {}", path.display());
    bytes
}

#[test]
fn every_reference_matches_current_programs_and_immutable_engine_recordings() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let catalogue = std::fs::read(root.join("../card-compiler/generated/catalog.json")).unwrap();
    let directory = root.join("../cards/reference/fixtures");
    let manifest: serde_json::Value = serde_json::from_slice(&std::fs::read(directory.join("manifest.json")).unwrap()).unwrap();
    assert_eq!(manifest["schema"], "swu-reference-corpus/v1");
    let recordings = manifest["recordings"].as_array().unwrap();
    assert!(!recordings.is_empty(), "missing reference recordings");
    let mut pools = BTreeMap::<&str, Vec<&serde_json::Value>>::new();
    let mut traces = BTreeSet::new();
    for row in recordings {
        let hash = row["poolSha256"].as_str().unwrap();
        pools.entry(hash).or_default().push(row);
        traces.insert(format!("{}.jsonl.gz", row["traceSha256"].as_str().unwrap()));
    }
    for (name, expected) in [("pools", pools.keys().map(|h| format!("{h}.json")).collect::<BTreeSet<_>>()), ("traces", traces)] {
        let actual = std::fs::read_dir(directory.join(name)).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect::<BTreeSet<_>>();
        assert_eq!(actual, expected, "unindexed reference files");
    }
    for (pool_hash, rows) in pools {
        let pool = checked_bytes(&directory.join(format!("pools/{pool_hash}.json")), pool_hash);
        let engine = Engine::from_compiled_pool_bytes(&pool, &catalogue).unwrap();
        for row in rows {
            let hash = row["traceSha256"].as_str().unwrap();
            let path = directory.join(format!("traces/{hash}.jsonl.gz"));
            checked_bytes(&path, hash);
            let result = check::check(&engine, &path).unwrap_or_else(|error| panic!("{}: {error}", row["caseId"]));
            assert!(result.matched && result.decisions > 0 && result.windows > 0);
            assert_eq!(result.decisions as u64, row["decisions"].as_u64().unwrap());
            assert_eq!(result.windows as u64, row["windows"].as_u64().unwrap());
        }
    }
}
