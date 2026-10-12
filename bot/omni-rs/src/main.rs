use omni_rs::{
    check::{self, open_jsonl, position_labels},
    search::{Limits, Search},
    Engine, State,
};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    env,
    io::{BufRead, Write},
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

const HELP: &str = "omni-rs — independent SWU subset simulator and endgame prover

  omni-rs check <trace.jsonl[.gz]>... [--pool FILE] [--catalogue FILE]
  omni-rs prove <positions.jsonl[.gz]> [--depth 12] [--ms N | --nodes N | --ms-field jsMs] [--pool FILE] [--catalogue FILE]
  omni-rs bench [trace-or-positions.jsonl[.gz]] [--nodes 100000] [--pool FILE] [--catalogue FILE]
  omni-rs catalogue <catalog.json> [--out-pool FILE]

Proof depth and nodes count action-window moves; decisions also counts prompt inputs.
All proof limits are cumulative across iterative depths and both candidate winners.
Positions must contain fullState from a pool-aware export-positions.js run.
bench excludes loading/parsing, includes all prompt choices between action windows,
and defaults to the first committed trace fixture. Output is JSON (one line per input).
--catalogue loads compiled card programs; --pool optionally restricts their card set
and binds trace provenance to that pool. Without --catalogue the strict pool is used.
catalogue reports runtime admission and rejection reasons, not game conformance.
";

#[derive(Default)]
struct Args {
    positional: Vec<String>,
    flags: BTreeMap<String, String>,
}
impl Args {
    fn parse(values: impl Iterator<Item = String>) -> Result<Self, String> {
        let mut result = Self::default();
        let mut values = values.peekable();
        while let Some(value) = values.next() {
            if value.starts_with("--") {
                let key = value.trim_start_matches("--");
                if ![
                    "pool",
                    "catalogue",
                    "out-pool",
                    "depth",
                    "ms",
                    "nodes",
                    "ms-field",
                    "table-entries",
                ]
                .contains(&key)
                {
                    return Err(format!("unknown option {value}\n{HELP}"));
                }
                let next = values
                    .next()
                    .ok_or_else(|| format!("{value} requires a value"))?;
                if result.flags.insert(key.into(), next).is_some() {
                    return Err(format!("duplicate option {value}"));
                }
            } else {
                result.positional.push(value);
            }
        }
        Ok(result)
    }
    fn number<T: std::str::FromStr>(&self, key: &str) -> Result<Option<T>, String> {
        self.flags
            .get(key)
            .map(|s| s.parse().map_err(|_| format!("invalid --{key} value {s}")))
            .transpose()
    }
}

fn duration(ms: f64) -> Result<Duration, String> {
    Duration::try_from_secs_f64(ms / 1_000.).map_err(|_| format!("invalid millisecond budget {ms}"))
}

fn emit(value: &impl serde::Serialize) -> Result<(), String> {
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    serde_json::to_writer(&mut out, value).map_err(|e| e.to_string())?;
    out.write_all(b"\n").map_err(|e| e.to_string())
}

fn read_bytes(path: &Path) -> Result<Vec<u8>, String> {
    std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))
}

fn load_engine(args: &Args) -> Result<Engine, String> {
    if args.flags.contains_key("out-pool") {
        return Err("--out-pool is only valid with the catalogue command".into());
    }
    if let Some(path) = args.flags.get("catalogue") {
        let catalogue = read_bytes(Path::new(path))?;
        if let Some(pool) = args.flags.get("pool") {
            return Engine::from_compiled_pool_bytes(&read_bytes(Path::new(pool))?, &catalogue);
        }
        return Engine::from_catalogue_bytes(&catalogue);
    }
    let default_pool = Path::new(env!("CARGO_MANIFEST_DIR")).join("../omni/rs/pool.json");
    let pool = args
        .flags
        .get("pool")
        .map(PathBuf::from)
        .unwrap_or(default_pool);
    Engine::from_pool(&pool)
}

fn catalogue(args: &Args) -> Result<(), String> {
    if args.positional.len() != 1 {
        return Err(format!(
            "catalogue requires one compiled catalogue file\n{HELP}"
        ));
    }
    for key in args.flags.keys() {
        if key != "out-pool" {
            return Err(format!("--{key} is not valid with the catalogue command"));
        }
    }
    let bytes = read_bytes(Path::new(&args.positional[0]))?;
    let value: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    let engine = Engine::from_catalogue_bytes(&bytes)?;
    let rejected = engine
        .rejected_cards()
        .ok_or("catalogue loader did not retain admission results")?;
    let entries = value["cards"].as_array().ok_or("catalogue missing cards")?;
    let mut admitted = BTreeMap::new();
    let mut rejections = BTreeMap::new();
    let mut admitted_sources = 0;
    let mut admitted_data = 0;
    let mut native_adapters = 0;
    for entry in entries {
        let code = entry["setCode"]
            .as_str()
            .ok_or("catalogue card missing code")?;
        let name = entry["internalName"]
            .as_str()
            .or_else(|| entry["card"]["internalName"].as_str())
            .unwrap_or("unnamed");
        if let Some(reason) = rejected.get(code) {
            rejections.insert(
                code,
                json!({"setCode":code,"internalName":name,"reason":reason}),
            );
        } else {
            let implementation = if entry["status"] != "supported" {
                native_adapters += 1;
                "nativeAdapter"
            } else if entry["sourcePath"].is_string() {
                admitted_sources += 1;
                "sourceIr"
            } else {
                admitted_data += 1;
                "dataOnly"
            };
            admitted.insert(
                code,
                json!({"setCode":code,"internalName":name,"implementation":implementation}),
            );
        }
    }
    if admitted.len() + rejections.len() != entries.len() {
        return Err("catalogue admission report does not partition all card entries".into());
    }
    if let Some(path) = args.flags.get("out-pool") {
        let mut bytes =
            serde_json::to_vec_pretty(&engine.compiled_pool()?).map_err(|e| e.to_string())?;
        bytes.push(b'\n');
        std::fs::write(path, bytes).map_err(|e| format!("{path}: {e}"))?;
    }
    emit(&json!({
        "schema":"omni-rs-catalogue-report-v1",
        "catalogueHash":engine.pool_hash(),
        "knownCards":entries.len(),
        "irConvertedCount":entries.iter().filter(|entry| entry["status"]=="supported").count(),
        "sourceAstConvertedCount":entries.iter().filter(|entry| entry["status"]=="supported" && entry["sourcePath"].is_string()).count(),
        "dataOnlyConvertedCount":entries.iter().filter(|entry| entry["status"]=="supported" && !entry["sourcePath"].is_string()).count(),
        "runtimeAdmittedCount":admitted.len(),
        "runtimeRejectedCount":rejections.len(),
        "runtimeAdmittedBreakdown":{"sourceIr":admitted_sources,"dataOnly":admitted_data,"nativeAdapters":native_adapters},
        "gameConformance":"not assessed by this report",
        "runtimeAdmittedCards":admitted.into_values().collect::<Vec<_>>(),
        "runtimeRejectedCards":rejections.into_values().collect::<Vec<_>>()
    }))
}

fn prove(engine: &Engine, args: &Args) -> Result<(), String> {
    if args.positional.len() != 1 {
        return Err(format!("prove requires one positions file\n{HELP}"));
    }
    let active_limits = ["nodes", "ms", "ms-field"]
        .into_iter()
        .filter(|key| args.flags.contains_key(*key))
        .count();
    if active_limits > 1 {
        return Err("choose only one of --nodes, --ms, or --ms-field".into());
    }
    let base = Limits {
        depth: args.number("depth")?.unwrap_or(12),
        nodes: args.number("nodes")?,
        time: args.number("ms")?.map(duration).transpose()?,
        table_entries: args.number("table-entries")?.unwrap_or(16_384),
    };
    let path = Path::new(&args.positional[0]);
    let mut search = Search::new(engine);
    for (line, text) in open_jsonl(path)?.lines().enumerate() {
        let text = text.map_err(|e| e.to_string())?;
        if text.trim().is_empty() {
            continue;
        }
        let value: Value = serde_json::from_str(&text)
            .map_err(|e| format!("{}:{}: {e}", path.display(), line + 1))?;
        let state_json = value.get("fullState").ok_or_else(|| format!("{}:{}: missing fullState; export again with --pool (legacy recorder snapshots omit rules state)", path.display(), line+1))?;
        if let Some(pool) = value.get("pool") {
            if pool["sha256"].as_str() != Some(engine.pool_hash()) {
                return Err(format!(
                    "{}:{}: position pool hash differs from loaded pool",
                    path.display(),
                    line + 1
                ));
            }
        }
        let state = engine
            .load_state(state_json)
            .map_err(|e| format!("{}:{}: {e}", path.display(), line + 1))?;
        // Catch unsupported or omitted starting-state information before proving.
        check::compare_states(state_json, &engine.snapshot(&state))
            .map_err(|e| format!("{}:{}: {e}", path.display(), line + 1))?;
        let mut limits = base;
        if let Some(field) = args.flags.get("ms-field") {
            limits.time = Some(duration(value[field].as_f64().ok_or_else(|| {
                format!(
                    "{}:{}: numeric budget field {field} missing",
                    path.display(),
                    line + 1
                )
            })?)?);
        }
        let result = search
            .solve(state, limits)
            .map_err(|e| format!("{}:{}: proof aborted: {e}", path.display(), line + 1))?;
        let mut record =
            serde_json::to_value(position_labels(&value)).map_err(|e| e.to_string())?;
        let result_value = serde_json::to_value(result).map_err(|e| e.to_string())?;
        record
            .as_object_mut()
            .unwrap()
            .extend(result_value.as_object().unwrap().clone());
        if let Some(time) = limits.time {
            record["budgetMs"] = json!(time.as_secs_f64() * 1000.);
        }
        emit(&record)?;
    }
    Ok(())
}

fn bench(engine: &Engine, args: &Args) -> Result<(), String> {
    if args.positional.len() > 1 {
        return Err("bench accepts at most one trace/positions file".into());
    }
    let path = if let Some(path) = args.positional.first() {
        PathBuf::from(path)
    } else {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
        let mut files = std::fs::read_dir(&dir)
            .map_err(|e| format!("{}: {e}; supply a trace to bench", dir.display()))?
            .filter_map(Result::ok)
            .map(|e| e.path())
            .filter(|p| p.extension().is_some_and(|e| e == "gz" || e == "jsonl"))
            .collect::<Vec<_>>();
        files.sort();
        files
            .into_iter()
            .next()
            .ok_or("no committed trace fixtures; supply a trace to bench")?
    };
    let initial = engine.load_state(&check::first_state(&path)?)?;
    let wanted = args.number::<u64>("nodes")?.unwrap_or(100_000);
    if wanted == 0 {
        return Err("bench --nodes must be positive".into());
    }
    let mut state = initial;
    let mut random = 0x6a09e667f3bcc909u64;
    let mut nodes = 0u64;
    let mut decisions = 0u64;
    let mut games = 0u64;
    let mut checksum = 0u64;
    let mut prompt_steps = 0usize;
    let start = Instant::now();
    loop {
        if state.is_terminal() {
            games += 1;
            checksum ^= state.zobrist();
            state = initial;
        }
        if state.is_action_window() {
            if nodes >= wanted {
                break;
            }
            nodes += 1;
            prompt_steps = 0;
            // Proof search hashes each decision; one hash per window is included
            // here to avoid benchmarking only the cheapest transition operation.
            checksum = checksum.rotate_left(1) ^ state.zobrist();
        } else {
            prompt_steps += 1;
            if prompt_steps > 100_000 {
                return Err("benchmark stuck in prompts for 100000 inputs".into());
            }
        }
        let actions = engine.legal_actions(&state);
        if actions.is_empty() {
            return Err("benchmark reached nonterminal state without legal actions".into());
        }
        random ^= random << 13;
        random ^= random >> 7;
        random ^= random << 17;
        state = engine.apply(&state, &actions[(random % actions.len() as u64) as usize])?;
        decisions += 1;
    }
    let seconds = start.elapsed().as_secs_f64();
    emit(
        &json!({"benchmark":"complete_action_windows", "source":path.display().to_string(),
        "nodes":nodes,"decisions":decisions,"games":games,"seconds":seconds,
        "nodesPerSecond":nodes as f64 / seconds, "microsecondsPerNode":seconds*1_000_000./nodes as f64,
        "stateBytes":std::mem::size_of::<State>(),"threads":1,"checksum":checksum,"checksumHex":format!("{checksum:016x}"),
        "setupExcluded":true,"profile":if cfg!(debug_assertions) {"debug"} else {"release"}}),
    )
}

fn run() -> Result<(), String> {
    let mut values = env::args().skip(1);
    let command = values.next().unwrap_or_else(|| "--help".into());
    if ["--help", "-h", "help"].contains(&command.as_str()) {
        print!("{HELP}");
        return Ok(());
    }
    let args = Args::parse(values)?;
    if command == "catalogue" {
        return catalogue(&args);
    }
    let engine = load_engine(&args)?;
    match command.as_str() {
        "check" => {
            if args.positional.is_empty() {
                return Err(format!("check requires at least one trace file\n{HELP}"));
            }
            let mut decisions = 0;
            let mut windows = 0;
            for file in &args.positional {
                let result = check::check(&engine, Path::new(file))?;
                decisions += result.decisions;
                windows += result.windows;
                emit(&result)?;
            }
            eprintln!(
                "matched {} traces, {decisions} decisions, {windows} action windows",
                args.positional.len()
            );
            Ok(())
        }
        "prove" => prove(&engine, &args),
        "bench" => bench(&engine, &args),
        _ => Err(format!("unknown command {command}\n{HELP}")),
    }
}

fn main() {
    // Large fixed-size states stay inline through deep prompt trees. A bounded
    // dedicated stack avoids depending on the invoking platform's small default.
    let outcome = std::thread::Builder::new()
        .name("omni-rs".into())
        .stack_size(64 * 1024 * 1024)
        .spawn(run)
        .expect("could not create simulator thread")
        .join();
    match outcome {
        Ok(Ok(())) => (),
        Ok(Err(error)) => {
            eprintln!("omni-rs: {error}");
            std::process::exit(1);
        }
        Err(_) => {
            eprintln!("omni-rs: simulator thread panicked");
            std::process::exit(1);
        }
    }
}
