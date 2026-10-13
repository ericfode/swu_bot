use omni_rs::{check, Engine};
use sha2::{Digest, Sha256};
use std::{collections::{BTreeMap, BTreeSet}, path::Path, io::Read};

fn checked_bytes(path: &Path, expected: &str) -> Vec<u8> {
    let bytes = std::fs::read(path).unwrap();
    assert_eq!(format!("{:x}", Sha256::digest(&bytes)), expected, "reference bytes changed: {}", path.display());
    bytes
}

fn read_manifest(directory: &Path) -> Result<serde_json::Value, Box<dyn std::error::Error>> {
    let json = directory.join("manifest.json");
    let gzip = directory.join("manifest.json.gz");
    if json.try_exists()? == gzip.try_exists()? {
        return Err("Reference corpus needs exactly one manifest.json or manifest.json.gz".into());
    }
    let bytes = if json.try_exists()? {
        std::fs::read(json)?
    } else {
        let compressed = std::fs::read(gzip)?;
        let mut decoded = Vec::new();
        flate2::read::MultiGzDecoder::new(compressed.as_slice()).read_to_end(&mut decoded)?;
        decoded
    };
    let document: serde_json::Value = serde_json::from_slice(&bytes)?;
    if document["schema"] != "swu-reference-corpus/v1" || !document["recordings"].as_array().is_some_and(|rows| !rows.is_empty()) {
        return Err("Invalid reference corpus v1 document".into());
    }
    Ok(document)
}

#[test]
fn reference_manifest_reader_accepts_both_formats_and_rejects_damage() {
    use std::io::Write;
    let directory = std::env::temp_dir().join(format!("swu-manifest-reader-{}", std::process::id()));
    std::fs::create_dir(&directory).unwrap();
    let raw = br#"{"schema":"swu-reference-corpus/v1","recordings":[{"caseId":"a","witness":null},{"caseId":"b"}]}"#;
    let json = directory.join("manifest.json");
    let gzip = directory.join("manifest.json.gz");
    assert!(read_manifest(&directory).is_err());
    std::fs::write(&json, raw).unwrap();
    let expected = read_manifest(&directory).unwrap();
    let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    encoder.write_all(raw).unwrap();
    let compressed = encoder.finish().unwrap();
    std::fs::write(&gzip, &compressed).unwrap();
    assert!(read_manifest(&directory).is_err());
    std::fs::remove_file(&json).unwrap();
    assert_eq!(read_manifest(&directory).unwrap(), expected);
    std::fs::write(&gzip, &compressed[..compressed.len()-4]).unwrap();
    assert!(read_manifest(&directory).is_err());
    std::fs::write(&gzip, b"not gzip").unwrap();
    assert!(read_manifest(&directory).is_err());
    std::fs::remove_file(&gzip).unwrap();
    std::fs::write(&json, br#"{"schema":"wrong","recordings":[{}]}"#).unwrap();
    assert!(read_manifest(&directory).is_err());
    std::fs::remove_dir_all(&directory).unwrap();
}

#[test]
fn every_reference_matches_current_programs_and_immutable_engine_recordings() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let catalogue = std::fs::read(root.join("../card-compiler/generated/catalog.json")).unwrap();
    let directory = root.join("../cards/reference/fixtures");
    let manifest = read_manifest(&directory).unwrap();
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
