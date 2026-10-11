//! Teaching a hand-written bot's habits to the model ("train heuristics into the action model").
//!
//! From trajectory shards, take every decision a chosen teacher bot made (e.g. rust-greedy, heuristic) and train
//! the prior head P(s, a) so that softmax over the legal actions puts the teacher's choice first. By default the
//! encoder is frozen and only the prior head learns, so Q, V and the world model are unchanged. With `--full` the
//! whole network learns to imitate (behaviour cloning); that is what works (README, "Teaching it a rule bot").
//! At play time, `--prior w` adds w * log softmax(P) to each action's score in action windows (`--prior-all`: everywhere).

use crate::cards::CardDb;
use crate::features::{encode, ACTION_DIM, STATE_DIM};
use crate::model::Net;
use crate::train::shard_files;
use burn::optim::{AdamWConfig, GradientsParams};
use burn::prelude::*;
use burn::store::{ModuleSnapshot, SafetensorsStore};
use burn::tensor::activation::log_softmax;
use burn::tensor::TensorData;
use serde_json::Value;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

/// Decisions with more legal actions than this are skipped (rare; keeps batches rectangular).
pub const MAX_ACTIONS: usize = 32;

#[derive(Default)]
pub struct Decisions {
    pub n: usize,
    /// [n * STATE_DIM]
    pub state: Vec<f32>,
    /// legal actions of all decisions back to back: [sum(count) * ACTION_DIM]
    pub action: Vec<f32>,
    /// [sum(count)]
    pub ids: Vec<i64>,
    /// first action row of each decision
    pub start: Vec<usize>,
    /// legal action count per decision
    pub count: Vec<usize>,
    pub chosen: Vec<usize>,
    /// game of each decision (numbered across all files), so validation can hold out whole games
    pub game: Vec<usize>,
    pub games: usize,
}

fn read(path: &Path, db: &CardDb, teachers: &[String], out: &mut Decisions) {
    let file = std::fs::File::open(path).expect("open shard");
    let reader: Box<dyn BufRead> = if path.to_string_lossy().ends_with(".gz") {
        Box::new(BufReader::new(flate2::read::MultiGzDecoder::new(file)))
    } else {
        Box::new(BufReader::new(file))
    };
    let mut seats: Vec<String> = vec![];
    for line in reader.lines() {
        let Ok(line) = line else { break };
        // cheap filter before parsing: only game headers and decisions
        if !(line.starts_with("{\"t\":\"game\"") || line.starts_with("{\"t\":\"d\"")) {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
        if v["t"] == "game" {
            out.games += 1;
            seats = v["bots"].as_array().map(|a| a.iter().map(|b| b.as_str().unwrap_or("").to_string()).collect()).unwrap_or_default();
            continue;
        }
        let seat = if v["you"] == "p1" { 0 } else { 1 };
        let Some(bot) = seats.get(seat) else { continue };
        if !teachers.iter().any(|t| t == bot) {
            continue;
        }
        let i = v["i"].as_i64().unwrap_or(-1);
        let enc = encode(&v, db);
        let n = enc.actions.len();
        if i < 0 || i as usize >= n || n < 2 || n > MAX_ACTIONS {
            continue;
        }
        out.state.extend_from_slice(&enc.state);
        out.start.push(out.ids.len());
        for k in 0..n {
            out.action.extend_from_slice(&enc.actions[k]);
            out.ids.push(enc.ids[k]);
        }
        out.count.push(n);
        out.chosen.push(i as usize);
        out.game.push(out.games - 1);
        out.n += 1;
    }
}

pub fn load(dirs: &[PathBuf], db: &CardDb, teachers: &[String]) -> Decisions {
    let files = shard_files(dirs);
    let parts: Vec<Decisions> = std::thread::scope(|sc| {
        let hs: Vec<_> = files
            .iter()
            .map(|f| {
                sc.spawn(move || {
                    let mut d = Decisions::default();
                    read(f, db, teachers, &mut d);
                    d
                })
            })
            .collect();
        hs.into_iter().map(|h| h.join().unwrap()).collect()
    });
    let mut all = Decisions::default();
    for mut p in parts {
        let base = all.ids.len();
        all.start.extend(p.start.iter().map(|x| x + base));
        all.n += p.n;
        all.state.append(&mut p.state);
        all.action.append(&mut p.action);
        all.ids.append(&mut p.ids);
        all.count.append(&mut p.count);
        all.chosen.append(&mut p.chosen);
        all.game.extend(p.game.iter().map(|g| g + all.games));
        all.games += p.games;
    }
    eprintln!("{} teacher decisions from {:?}", all.n, teachers);
    all
}

/// Mean cross-entropy and top-1 agreement of the prior with the teacher on `idx`.
/// With `frozen`, the joint features come from that fixed encoder and only the prior head learns; without it the whole
/// network learns to imitate (behaviour cloning).
fn batch_loss(net: &Net, frozen: Option<&Net>, d: &Decisions, idx: &[usize], dev: &Device) -> (Tensor<1>, Tensor<1>) {
    let b = idx.len();
    let rows = b * MAX_ACTIONS;
    let mut s = Vec::with_capacity(rows * STATE_DIM);
    let mut a = Vec::with_capacity(rows * ACTION_DIM);
    let mut ids = Vec::with_capacity(rows);
    let mut mask = Vec::with_capacity(rows);
    let mut onehot = vec![0.0f32; rows];
    for (r, &i) in idx.iter().enumerate() {
        let (st, c) = (d.start[i], d.count[i]);
        for k in 0..MAX_ACTIONS {
            s.extend_from_slice(&d.state[i * STATE_DIM..(i + 1) * STATE_DIM]);
            mask.push(if k < c { 0.0 } else { -1e9 });
            if k < c {
                a.extend_from_slice(&d.action[(st + k) * ACTION_DIM..(st + k + 1) * ACTION_DIM]);
                ids.push(d.ids[st + k]);
            } else {
                a.extend(std::iter::repeat(0.0).take(ACTION_DIM));
                ids.push(0);
            }
        }
        onehot[r * MAX_ACTIONS + d.chosen[i]] = 1.0;
    }
    let j = match frozen {
        // the encoder is frozen: compute its features without gradients, then train only the prior head
        Some(frozen) => {
            let plain = Device::flex();
            let (_, j) = frozen.encode(
                Tensor::from_data(TensorData::new(s, [rows, STATE_DIM]), &plain),
                Tensor::from_data(TensorData::new(a, [rows, ACTION_DIM]), &plain),
                Tensor::from_data(TensorData::new(ids, [rows]), &plain),
            );
            Tensor::<2>::from_data(j.into_data(), dev)
        }
        None => {
            net.encode(
                Tensor::from_data(TensorData::new(s, [rows, STATE_DIM]), dev),
                Tensor::from_data(TensorData::new(a, [rows, ACTION_DIM]), dev),
                Tensor::from_data(TensorData::new(ids, [rows]), dev),
            )
            .1
        }
    };
    let logits = net.prior_head(j).reshape([b, MAX_ACTIONS]) + Tensor::<2>::from_data(TensorData::new(mask, [b, MAX_ACTIONS]), dev);
    let target = Tensor::<2>::from_data(TensorData::new(onehot, [b, MAX_ACTIONS]), dev);
    let logp = log_softmax(logits.clone(), 1);
    let ce = (logp * target.clone()).sum_dim(1).mean().neg();
    // agreement: the teacher's action has the highest prior
    let best = logits.clone().max_dim(1);
    let picked = (logits * target).sum_dim(1);
    let agree = picked.greater_equal(best).float().mean();
    (ce, agree)
}

pub fn train(d: &Decisions, init: &Path, out: &Path, epochs: usize, batch: usize, lr: f64, full: bool) {
    let dev = Device::flex().autodiff();
    let mut net = Net::new(&dev);
    net.load_from(&mut SafetensorsStore::from_file(init).allow_partial(true)).expect("load base model");
    let mut frozen = Net::new(&Device::flex());
    frozen.load_from(&mut SafetensorsStore::from_file(init).allow_partial(true)).expect("load base model");
    let frozen = frozen.valid();
    let mut opt = AdamWConfig::new().with_weight_decay(0.01).init();
    // hold out every 20th game (whole games: decisions of one game are strongly correlated)
    let (tr, va): (Vec<usize>, Vec<usize>) = (0..d.n).partition(|&i| d.game[i] % 20 != 0);
    assert!(!tr.is_empty() && !va.is_empty(), "need teacher decisions in both training and held-out games ({} decisions)", d.n);
    let mut tr = tr;
    let mut seed = 11u64;
    let mut best = f32::MAX;
    for epoch in 0..epochs {
        for i in (1..tr.len()).rev() {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            tr.swap(i, (seed >> 33) as usize % (i + 1));
        }
        let mut tot = 0.0;
        let mut nb = 0;
        for chunk in tr.chunks(batch) {
            if chunk.len() < batch {
                break;
            }
            let (ce, _) = batch_loss(&net, (!full).then_some(&frozen), d, chunk, &dev);
            tot += ce.clone().into_scalar::<f32>();
            nb += 1;
            let grads = GradientsParams::from_grads(ce.backward(), &net);
            net = opt.step(lr, net, grads);
        }
        let valid = net.valid();
        let plain = Device::flex();
        let (mut vce, mut vag, mut vn) = (0.0f32, 0.0f32, 0usize);
        for chunk in va.chunks(1024) {
            let (ce, ag) = batch_loss(&valid, if full { None } else { Some(&frozen) }, d, chunk, &plain);
            vce += ce.into_scalar::<f32>() * chunk.len() as f32;
            vag += ag.into_scalar::<f32>() * chunk.len() as f32;
            vn += chunk.len();
        }
        let (vce, vag) = (vce / vn.max(1) as f32, vag / vn.max(1) as f32);
        eprintln!("prior epoch {epoch}: train ce {:.4}, valid ce {vce:.4}, picks the teacher's move {:.1}% of the time", tot / nb.max(1) as f32, vag * 100.0);
        if vce < best {
            best = vce;
            net.valid().save_into(&mut SafetensorsStore::from_file(out).overwrite(true)).expect("save");
            eprintln!("  saved");
        }
    }
}
