use omni_rs::{check, Engine};
use std::path::Path;

#[test]
fn compiled_card_programs_match_all_expanded_engine_receipts() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let directory = root.join("tests/compiled-fixtures");
    let pool = std::fs::read(directory.join("pool.json")).unwrap();
    let catalogue = std::fs::read(root.join("../card-compiler/generated/catalog.json")).unwrap();
    let engine = Engine::from_compiled_pool_bytes(&pool, &catalogue).unwrap();
    let mut fixtures = std::fs::read_dir(&directory)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.extension().is_some_and(|extension| extension == "gz"))
        .collect::<Vec<_>>();
    fixtures.sort();
    assert_eq!(
        fixtures.len(),
        16,
        "all expanded engine receipts must be present"
    );
    for path in fixtures {
        let result = check::check(&engine, &path)
            .unwrap_or_else(|error| panic!("{}: {error}", path.display()));
        assert!(result.matched);
        assert!(result.decisions > 0);
        assert!(result.windows > 0);
    }
}
