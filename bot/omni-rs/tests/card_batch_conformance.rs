use omni_rs::{check, Engine};
use sha2::{Digest, Sha256};
use std::path::Path;

fn checked_bytes(path: &Path, expected: &serde_json::Value) -> Vec<u8> {
    let bytes = std::fs::read(path).unwrap();
    assert_eq!(format!("{:x}", Sha256::digest(&bytes)), expected.as_str().unwrap(), "receipt bytes changed: {}", path.display());
    bytes
}

#[test]
fn every_card_batch_matches_current_programs_and_immutable_engine_receipts() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let catalogue = std::fs::read(root.join("../card-compiler/generated/catalog.json")).unwrap();
    let batches = root.join("tests/card-batches");
    let mut indexes = std::fs::read_dir(&batches).unwrap().map(|entry| entry.unwrap().path())
        .filter(|path| path.is_dir()).collect::<Vec<_>>();
    indexes.sort();
    assert!(!indexes.is_empty(), "missing card batch receipts");
    for batch in indexes {
        let index: serde_json::Value = serde_json::from_slice(&std::fs::read(batch.join("receipt-index.json")).unwrap()).unwrap();
        assert_eq!(index["schema"], "swu-card-batch-receipts/v1");
        for corpus in index["corpora"].as_array().unwrap() {
            let directory = batch.join(corpus["directory"].as_str().unwrap());
            let pool = checked_bytes(&directory.join("pool.json"), &corpus["poolSha256"]);
            let engine = Engine::from_compiled_pool_bytes(&pool, &catalogue).unwrap();
            let fixtures = corpus["fixtures"].as_array().unwrap();
            assert!(!fixtures.is_empty());
            let actual_count = std::fs::read_dir(&directory).unwrap().filter(|entry|
                entry.as_ref().unwrap().path().extension().is_some_and(|extension| extension == "gz")).count();
            assert_eq!(actual_count, fixtures.len(), "fixture inventory changed: {}", directory.display());
            for fixture in fixtures {
                let path = directory.join(fixture["file"].as_str().unwrap());
                checked_bytes(&path, &fixture["sha256"]);
                let result = check::check(&engine, &path).unwrap_or_else(|error| panic!("{}: {error}", path.display()));
                assert!(result.matched && result.decisions > 0 && result.windows > 0);
            }
        }
    }
}
