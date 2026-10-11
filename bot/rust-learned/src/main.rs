//! swu-learned: a tiny learned world model + action model for Star Wars Unlimited, in Rust with Burn.
//!
//!   swu-learned play  --model M [--world 0] [--heur 0] [--prior 0] [--prior-all] [--temp 0] [--epsilon 0] [--name N]
//!   swu-learned train --data DIR[,DIR] --out M [--epochs 3] [--batch 512] [--lr 0.002] [--init M] [--teacher M --td 0.5]
//!   swu-learned explain --model M --data DIR
//!   swu-learned train-prior --data DIR --teacher-bots rust-greedy --init M --out M2 [--epochs 3] [--full]
//!   swu-learned info
//!
//! `play` speaks spec/stdio-protocol.md on stdin/stdout. Card data is read from $SWU_CARD_DATA
//! (default forceteki/test/json, relative to the working directory the adapter starts us in).

mod cards;
mod features;
mod model;
mod play;
mod prior;
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
            let model = flag(&args, "model").unwrap_or_else(|| "bot/rust-learned/models/learned-v4.safetensors".into());
            let mut net = model::Net::new(&Device::flex());
            let mut store = SafetensorsStore::from_file(&model).allow_partial(true);
            if let Err(e) = net.load_from(&mut store) {
                eprintln!("swu-learned: cannot load {model}: {e:?}");
                std::process::exit(2);
            }
            let cfg = play::PlayCfg {
                world: num(&args, "world", 0.0),
                heur: num(&args, "heur", 0.0),
                temp: num(&args, "temp", 0.0),
                epsilon: num(&args, "epsilon", 0.0),
                prior: num(&args, "prior", 0.0),
                prior_all: args.iter().any(|a| a == "--prior-all"),
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
            let mut d = train::load(&data, &db, threads);
            if let Some(t) = flag(&args, "teacher") {
                train::bootstrap(&mut d, &PathBuf::from(t), num(&args, "td", 0.5));
            }
            let cfg = train::TrainCfg {
                epochs: num(&args, "epochs", 3),
                batch: num(&args, "batch", 512),
                lr: num(&args, "lr", 0.002),
                world_weight: num(&args, "world-weight", 0.5),
                value_weight: num(&args, "value-weight", 1.0),
                seed: num(&args, "seed", 7),
                max_rows: num(&args, "max-rows", usize::MAX),
                weight_decay: num(&args, "weight-decay", 0.01),
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
        "train-prior" => {
            let data: Vec<PathBuf> = flag(&args, "data").expect("--data").split(',').map(PathBuf::from).collect();
            let teachers: Vec<String> = flag(&args, "teacher-bots").expect("--teacher-bots").split(',').map(String::from).collect();
            let init = PathBuf::from(flag(&args, "init").expect("--init"));
            let out = PathBuf::from(flag(&args, "out").expect("--out"));
            if let Some(dir) = out.parent() {
                std::fs::create_dir_all(dir).unwrap();
            }
            let d = prior::load(&data, &card_db(), &teachers);
            if d.n == 0 {
                eprintln!("swu-learned: no decisions by {teachers:?} in {data:?}; check --teacher-bots and --data");
                std::process::exit(2);
            }
            prior::train(&d, &init, &out, num(&args, "epochs", 3), num(&args, "batch", 256), num(&args, "lr", 0.002), args.iter().any(|a| a == "--full"));
        }
        "explain" => {
            // how much the value head moves when one state feature moves by one standard deviation
            let model = flag(&args, "model").expect("--model");
            let data: Vec<PathBuf> = flag(&args, "data").expect("--data").split(',').map(PathBuf::from).collect();
            let dev = Device::flex();
            let mut net = model::Net::new(&dev);
            net.load_from(&mut SafetensorsStore::from_file(&model).allow_partial(true)).expect("load model");
            let db = card_db();
            let d = train::load(&data, &db, 4);
            let rows = d.n.min(20_000);
            let step = (d.n / rows).max(1);
            let sd = features::STATE_DIM;
            let idx: Vec<usize> = (0..rows).map(|k| k * step).collect();
            let mut base: Vec<f32> = Vec::with_capacity(rows * sd);
            for &i in &idx {
                base.extend_from_slice(&d.state[i * sd..(i + 1) * sd]);
            }
            let mean: Vec<f32> = (0..sd).map(|j| idx.iter().map(|&i| d.state[i * sd + j]).sum::<f32>() / rows as f32).collect();
            let std: Vec<f32> = (0..sd)
                .map(|j| (idx.iter().map(|&i| (d.state[i * sd + j] - mean[j]).powi(2)).sum::<f32>() / rows as f32).sqrt())
                .collect();
            let v = |x: Vec<f32>| -> Vec<f32> {
                let t = Tensor::<2>::from_data(burn::tensor::TensorData::new(x, [rows, sd]), &dev);
                burn::tensor::activation::sigmoid(net.value(t)).into_data().try_to_vec::<f32>().unwrap()
            };
            let v0 = v(base.clone());
            let names = features::state_names();
            let mut out = vec![];
            for j in 0..sd {
                if std[j] < 1e-6 {
                    continue;
                }
                let mut x = base.clone();
                for r in 0..rows {
                    x[r * sd + j] += std[j];
                }
                let v1 = v(x);
                let eff = v1.iter().zip(&v0).map(|(a, b)| a - b).sum::<f32>() / rows as f32;
                out.push(serde_json::json!({"name": names[j], "weight": eff, "std": std[j]}));
            }
            out.sort_by(|a, b| b["weight"].as_f64().unwrap().abs().partial_cmp(&a["weight"].as_f64().unwrap().abs()).unwrap());
            println!("{}", serde_json::to_string_pretty(&out).unwrap());
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
