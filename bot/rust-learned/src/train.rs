//! Training from "swu-traj/1" trajectory shards (written by bot/learn/collect.js).
//!
//! Labels come from the game result only: every decision of the winner is labelled 1, the loser's 0.
//! With a random behaviour policy this makes Q(s, a) the win rate of "take a, then play randomly",
//! which is one step of policy improvement over random. Retraining on the improved bot's own games
//! (self-play) repeats the step.

use crate::cards::CardDb;
use crate::features::{encode, ACTION_DIM, STATE_DIM, WORLD_DIM};
use crate::model::Net;
use burn::optim::{AdamWConfig, GradientsParams};
use burn::prelude::*;
use burn::store::{ModuleSnapshot, SafetensorsStore};
use burn::tensor::activation::softplus;
use burn::tensor::TensorData;
use serde_json::Value;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

#[derive(Default)]
pub struct Data {
    pub n: usize,
    pub state: Vec<f32>,
    pub action: Vec<f32>,
    pub ids: Vec<i64>,
    pub y: Vec<f32>,
    pub world: Vec<f32>,
    pub wmask: Vec<f32>,
    /// Game index per row, for a train/validation split by game.
    pub game: Vec<u32>,
    /// Row of the same seat's next action window in the same game (its whole action resolved), or -1.
    pub next: Vec<i64>,
}

impl Data {
    fn append(&mut self, mut o: Data, game_offset: u32) {
        let rows = self.n as i64;
        self.next.extend(o.next.iter().map(|&x| if x < 0 { x } else { x + rows }));
        self.n += o.n;
        self.state.append(&mut o.state);
        self.action.append(&mut o.action);
        self.ids.append(&mut o.ids);
        self.y.append(&mut o.y);
        self.world.append(&mut o.world);
        self.wmask.append(&mut o.wmask);
        self.game.extend(o.game.iter().map(|g| g + game_offset));
    }
}

pub fn shard_files(dirs: &[PathBuf]) -> Vec<PathBuf> {
    let mut out = vec![];
    for d in dirs {
        if d.is_file() {
            out.push(d.clone());
            continue;
        }
        if let Ok(rd) = std::fs::read_dir(d) {
            for e in rd.flatten() {
                let p = e.path();
                let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
                if name.ends_with(".jsonl.gz") || name.ends_with(".jsonl") {
                    out.push(p);
                }
            }
        }
    }
    out.sort();
    out
}

/// Reads one shard. Returns rows plus the number of games used.
fn read_shard(path: &Path, db: &CardDb) -> (Data, u32) {
    let file = std::fs::File::open(path).expect("open shard");
    let reader: Box<dyn BufRead> = if path.to_string_lossy().ends_with(".gz") {
        Box::new(BufReader::new(flate2::read::MultiGzDecoder::new(file)))
    } else {
        Box::new(BufReader::new(file))
    };
    let mut data = Data::default();
    let mut games = 0u32;
    // rows of the current game: (seat, state, action, id, actionWindow)
    let mut cur: Vec<(String, Vec<f32>, Vec<f32>, i64, bool)> = vec![];
    for line in reader.lines() {
        let Ok(line) = line else { break };
        let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
        match v.get("t").and_then(|t| t.as_str()) {
            Some("game") => cur.clear(),
            Some("d") => {
                let i = v.get("i").and_then(|i| i.as_i64()).unwrap_or(-1);
                if i < 0 {
                    continue;
                }
                let enc = encode(&v, db);
                let i = i as usize;
                if i >= enc.actions.len() {
                    continue;
                }
                let seat = v["you"].as_str().unwrap_or("p1").to_string();
                let aw = v["prompt"]["actionWindow"].as_bool().unwrap_or(false);
                cur.push((seat, enc.state, enc.actions[i].clone(), enc.ids[i], aw));
            }
            Some("end") => {
                let winner = v.get("winner").and_then(|w| w.as_str()).unwrap_or("");
                if winner == "p1" || winner == "p2" {
                    push_game(&mut data, &cur, winner, games);
                    games += 1;
                }
                cur.clear();
            }
            _ => {}
        }
    }
    (data, games)
}

fn push_game(data: &mut Data, rows: &[(String, Vec<f32>, Vec<f32>, i64, bool)], winner: &str, game: u32) {
    let first = data.n as i64;
    for (k, (seat, s, a, id, _)) in rows.iter().enumerate() {
        let nxt = rows[k + 1..].iter().position(|r| &r.0 == seat && r.4).map(|j| first + (k + 1 + j) as i64).unwrap_or(-1);
        data.next.push(nxt);
        // world target: my board at my next action window, as a change from now
        let next = rows[k + 1..].iter().find(|r| &r.0 == seat && r.4);
        match next {
            Some(nx) => {
                data.world.extend((0..WORLD_DIM).map(|j| nx.1[j] - s[j]));
                data.wmask.push(1.0);
            }
            None => {
                data.world.extend(std::iter::repeat(0.0).take(WORLD_DIM));
                data.wmask.push(0.0);
            }
        }
        data.state.extend_from_slice(s);
        data.action.extend_from_slice(a);
        data.ids.push(*id);
        data.y.push((seat == winner) as i32 as f32);
        data.game.push(game);
        data.n += 1;
    }
}

pub fn load(dirs: &[PathBuf], db: &CardDb, threads: usize) -> Data {
    let files = shard_files(dirs);
    eprintln!("reading {} shard files", files.len());
    let chunks: Vec<Vec<PathBuf>> = (0..threads.max(1))
        .map(|t| files.iter().skip(t).step_by(threads.max(1)).cloned().collect())
        .collect();
    let parts: Vec<Vec<(Data, u32)>> = std::thread::scope(|sc| {
        let hs: Vec<_> = chunks
            .iter()
            .map(|c| sc.spawn(move || c.iter().map(|p| read_shard(p, db)).collect::<Vec<_>>()))
            .collect();
        hs.into_iter().map(|h| h.join().unwrap()).collect()
    });
    let mut all = Data::default();
    let mut offset = 0u32;
    for part in parts {
        for (d, g) in part {
            all.append(d, offset);
            offset += g;
        }
    }
    eprintln!("{} decisions from {} finished games", all.n, offset);
    all
}

pub struct TrainCfg {
    pub epochs: usize,
    pub batch: usize,
    pub lr: f64,
    pub world_weight: f32,
    pub value_weight: f32,
    pub seed: u64,
    pub max_rows: usize,
    pub weight_decay: f32,
}

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E3779B97F4A7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58476D1CE4E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D049BB133111EB);
        z ^ (z >> 31)
    }
}

fn batch_tensors(d: &Data, idx: &[usize], dev: &Device) -> (Tensor<2>, Tensor<2>, Tensor<1, Int>, Tensor<2>, Tensor<2>, Tensor<2>) {
    let b = idx.len();
    let mut s = Vec::with_capacity(b * STATE_DIM);
    let mut a = Vec::with_capacity(b * ACTION_DIM);
    let mut w = Vec::with_capacity(b * WORLD_DIM);
    let (mut ids, mut y, mut m) = (Vec::with_capacity(b), Vec::with_capacity(b), Vec::with_capacity(b));
    for &i in idx {
        s.extend_from_slice(&d.state[i * STATE_DIM..(i + 1) * STATE_DIM]);
        a.extend_from_slice(&d.action[i * ACTION_DIM..(i + 1) * ACTION_DIM]);
        w.extend_from_slice(&d.world[i * WORLD_DIM..(i + 1) * WORLD_DIM]);
        ids.push(d.ids[i]);
        y.push(d.y[i]);
        m.push(d.wmask[i]);
    }
    (
        Tensor::from_data(TensorData::new(s, [b, STATE_DIM]), dev),
        Tensor::from_data(TensorData::new(a, [b, ACTION_DIM]), dev),
        Tensor::from_data(TensorData::new(ids, [b]), dev),
        Tensor::from_data(TensorData::new(y, [b, 1]), dev),
        Tensor::from_data(TensorData::new(w, [b, WORLD_DIM]), dev),
        Tensor::from_data(TensorData::new(m, [b, 1]), dev),
    )
}

/// Binary cross-entropy on logits, per row: softplus(x) - y*x.
fn bce(logit: Tensor<2>, y: Tensor<2>) -> Tensor<2> {
    softplus(logit.clone(), 1.0) - y * logit
}

#[derive(serde::Serialize, Clone, Debug)]
pub struct EpochLog {
    pub epoch: usize,
    pub train_q: f32,
    pub val_q: f32,
    pub val_v: f32,
    pub val_world: f32,
    pub val_q_acc: f32,
    pub secs: f32,
}

pub fn train(data: &Data, cfg: &TrainCfg, init: Option<&Path>, out: &Path) -> Vec<EpochLog> {
    let dev = Device::flex().autodiff();
    let mut net = Net::new(&dev);
    if let Some(p) = init {
        let mut store = SafetensorsStore::from_file(p);
        net.load_from(&mut store).expect("load init model");
        eprintln!("continuing from {}", p.display());
    }
    let mut opt = AdamWConfig::new().with_weight_decay(cfg.weight_decay).init();
    let mut rng = Rng(cfg.seed);

    // validation = every 20th game
    let (mut tr, mut va): (Vec<usize>, Vec<usize>) = (0..data.n).partition(|&i| data.game[i] % 20 != 0);
    let shuffle = |v: &mut Vec<usize>, rng: &mut Rng| {
        for i in (1..v.len()).rev() {
            let j = (rng.next() % (i as u64 + 1)) as usize;
            v.swap(i, j);
        }
    };
    shuffle(&mut va, &mut rng);
    va.truncate(50_000);
    eprintln!("train rows {}, validation rows {}", tr.len(), va.len());
    let mut logs = vec![];
    let t0 = std::time::Instant::now();
    for epoch in 0..cfg.epochs {
        shuffle(&mut tr, &mut rng);
        let rows = tr.len().min(cfg.max_rows);
        let mut tot = 0.0f64;
        let mut nb = 0;
        let steps = rows / cfg.batch;
        for (k, chunk) in tr[..rows].chunks(cfg.batch).enumerate() {
            if chunk.len() < cfg.batch {
                break;
            }
            let (s, a, ids, y, w, m) = batch_tensors(data, chunk, &dev);
            let o = net.forward(s, a, ids);
            let lq = bce(o.q, y.clone()).mean();
            let lv = bce(o.v, y).mean();
            let lw = ((o.world - w).powi_scalar(2) * m).mean() * (WORLD_DIM as f32);
            let loss = lq.clone() + lv * cfg.value_weight + lw * cfg.world_weight;
            let grads = GradientsParams::from_grads(loss.backward(), &net);
            // decay the step size over the run
            let frac = (epoch * steps + k) as f64 / (cfg.epochs * steps).max(1) as f64;
            let lr = cfg.lr * (1.0 - 0.9 * frac);
            net = opt.step(lr, net, grads);
            tot += lq.into_scalar::<f32>() as f64;
            nb += 1;
            if k % 500 == 0 {
                eprintln!("  epoch {epoch} batch {k}/{steps} q-loss {:.4}", tot / nb as f64);
            }
        }
        let (vq, vv, vw, acc) = evaluate(&net.valid(), data, &va);
        let log = EpochLog {
            epoch,
            train_q: (tot / nb.max(1) as f64) as f32,
            val_q: vq,
            val_v: vv,
            val_world: vw,
            val_q_acc: acc,
            secs: t0.elapsed().as_secs_f32(),
        };
        eprintln!("{log:?}");
        // keep the epoch with the best validation loss of the action model
        if logs.iter().all(|l: &EpochLog| log.val_q < l.val_q) {
            let mut store = SafetensorsStore::from_file(out).overwrite(true);
            net.valid().save_into(&mut store).expect("save model");
            eprintln!("  saved (best so far)");
        }
        logs.push(log);
    }
    logs
}

fn evaluate(net: &Net, data: &Data, idx: &[usize]) -> (f32, f32, f32, f32) {
    let dev = Device::flex();
    let (mut q, mut v, mut w, mut acc, mut n) = (0.0f64, 0.0f64, 0.0f64, 0.0f64, 0usize);
    for chunk in idx.chunks(4096) {
        let (s, a, ids, y, wt, m) = batch_tensors(data, chunk, &dev);
        let o = net.forward(s, a, ids);
        let b = chunk.len() as f64;
        q += bce(o.q.clone(), y.clone()).mean().into_scalar::<f32>() as f64 * b;
        v += bce(o.v, y.clone()).mean().into_scalar::<f32>() as f64 * b;
        w += ((o.world - wt).powi_scalar(2) * m).mean().into_scalar::<f32>() as f64 * b * WORLD_DIM as f64;
        let pred = o.q.greater_elem(0.0).float();
        acc += pred.equal(y).float().mean().into_scalar::<f32>() as f64 * b;
        n += chunk.len();
    }
    let n = n.max(1) as f64;
    ((q / n) as f32, (v / n) as f32, (w / n) as f32, (acc / n) as f32)
}

/// Bootstrapped labels: blend each row's game result with a teacher's value of the same seat's next action window.
/// `w` = 0 keeps pure game results; `w` = 1 is one-step TD. Lower-variance targets for Q and V.
pub fn bootstrap(data: &mut Data, teacher: &Path, w: f32) {
    let dev = Device::flex();
    let mut net = Net::new(&dev);
    net.load_from(&mut SafetensorsStore::from_file(teacher)).expect("load teacher");
    let mut v = Vec::with_capacity(data.n);
    for start in (0..data.n).step_by(8192) {
        let end = (start + 8192).min(data.n);
        let t = Tensor::<2>::from_data(TensorData::new(data.state[start * STATE_DIM..end * STATE_DIM].to_vec(), [end - start, STATE_DIM]), &dev);
        v.extend(burn::tensor::activation::sigmoid(net.value(t)).into_data().try_to_vec::<f32>().unwrap());
    }
    let mut changed = 0usize;
    for i in 0..data.n {
        let nx = data.next[i];
        if nx >= 0 {
            data.y[i] = (1.0 - w) * data.y[i] + w * v[nx as usize];
            changed += 1;
        }
    }
    eprintln!("bootstrapped {changed} of {} labels from {} (w = {w})", data.n, teacher.display());
}
