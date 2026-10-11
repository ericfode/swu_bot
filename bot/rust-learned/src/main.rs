//! swu-learned: a tiny learned world model + action model for Star Wars Unlimited, in Rust with Burn.
//!
//!   swu-learned play  --model M [--world 0] [--heur 0] [--temp 0] [--epsilon 0] [--name N]
//!   swu-learned train --data DIR[,DIR] --out M [--epochs 3] [--batch 512] [--lr 0.002] [--init M]
//!   swu-learned info
//!
//! `play` speaks spec/stdio-protocol.md on stdin/stdout. Card data is read from $SWU_CARD_DATA
//! (default forceteki/test/json, relative to the working directory the adapter starts us in).

mod cards;
mod features;
mod model;
mod play;
mod train;

use burn::prelude::*;
use burn::store::{ModuleSnapshot, SafetensorsStore};
use std::path::PathBuf;

fn flag(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == &format!("--{name}")).and_then(|i| args.get(i + 1)).cloned()
}

fn num<T: std::str::FromStr>(args: &[String], name: &str, dflt: T) -> T {
    flag(args, name).and_then(|v| v.parse().ok()).unwrap_or(dflt)
}

fn card_db() -> cards::CardDb {
    let dir = std::env::var("SWU_CARD_DATA").unwrap_or_else(|_| "forceteki/test/json".into());
    cards::CardDb::load(&PathBuf::from(dir))
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let cmd = args.get(1).map(String::as_str).unwrap_or("play");
    match cmd {
        "play" => {
            let model = flag(&args, "model").unwrap_or_else(|| "bot/rust-learned/models/learned-v1.safetensors".into());
            let mut net = model::Net::new(&Device::flex());
            let mut store = SafetensorsStore::from_file(&model);
            if let Err(e) = net.load_from(&mut store) {
                eprintln!("swu-learned: cannot load {model}: {e:?}");
                std::process::exit(2);
            }
            let cfg = play::PlayCfg {
                world: num(&args, "world", 0.0),
                heur: num(&args, "heur", 0.0),
                temp: num(&args, "temp", 0.0),
                epsilon: num(&args, "epsilon", 0.0),
                thoughts: flag(&args, "thoughts").or_else(|| std::env::var("SWU_LEARNED_THOUGHTS").ok()).map(PathBuf::from),
            };
            let name = flag(&args, "name").unwrap_or_else(|| "rust-learned".into());
            play::run(play::Brain::new(net, card_db(), cfg), &name);
        }
        "train" => {
            let data: Vec<PathBuf> = flag(&args, "data").expect("--data").split(',').map(PathBuf::from).collect();
            let out = PathBuf::from(flag(&args, "out").expect("--out"));
            if let Some(dir) = out.parent() {
                std::fs::create_dir_all(dir).ok();
            }
            let db = card_db();
            let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
            let d = train::load(&data, &db, threads);
            let cfg = train::TrainCfg {
                epochs: num(&args, "epochs", 3),
                batch: num(&args, "batch", 512),
                lr: num(&args, "lr", 0.002),
                world_weight: num(&args, "world-weight", 0.5),
                value_weight: num(&args, "value-weight", 1.0),
                seed: num(&args, "seed", 7),
                max_rows: num(&args, "max-rows", usize::MAX),
            };
            let init = flag(&args, "init").map(PathBuf::from);
            let logs = train::train(&d, &cfg, init.as_deref(), &out);
            let log_path = out.with_extension("train.json");
            let meta = serde_json::json!({
                "model": out, "data": data, "rows": d.n, "epochs": logs,
                "stateDim": features::STATE_DIM, "actionDim": features::ACTION_DIM, "worldDim": features::WORLD_DIM,
            });
            std::fs::write(&log_path, serde_json::to_string_pretty(&meta).unwrap()).unwrap();
            eprintln!("wrote {} and {}", out.display(), log_path.display());
        }
        "info" => {
            println!(
                "state {} action {} world {} id buckets {} cards {}",
                features::STATE_DIM,
                features::ACTION_DIM,
                features::WORLD_DIM,
                features::ID_BUCKETS,
                card_db().len()
            );
        }
        other => {
            eprintln!("unknown command {other}; use play | train | info");
            std::process::exit(2);
        }
    }
}
