//! The stdio bot (spec/stdio-protocol.md, v1): one JSON line in, one JSON line out.
//!
//! Score of a legal action a in state s:
//!     q(s, a)                                 action model: logit of "I win if I take a"
//!   + world * v(s + W(s, a))                  world model: value of the board it predicts
//!   + heur  * h(s + W(s, a))                  hand-written heuristic on the predicted board
//! then argmax (or softmax sampling with `temp` > 0). The three knobs are command-line flags.

use crate::cards::CardDb;
use crate::features::{encode, heuristic, ACTION_DIM, STATE_DIM, WORLD_DIM};
use crate::model::Net;
use burn::prelude::*;
use burn::tensor::TensorData;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, Write};

pub struct PlayCfg {
    pub world: f32,
    pub heur: f32,
    pub temp: f32,
    pub epsilon: f32,
    /// Write the latest decision's scores here (for the dashboard panel).
    pub thoughts: Option<std::path::PathBuf>,
}

pub struct Scored {
    pub q: Vec<f32>,
    pub v_now: f32,
    pub v_next: Vec<f32>,
    pub h_next: Vec<f32>,
    pub score: Vec<f32>,
}

pub struct Brain {
    pub net: Net,
    pub db: CardDb,
    pub cfg: PlayCfg,
    dev: Device,
}

fn sigmoid(x: f32) -> f32 {
    1.0 / (1.0 + (-x).exp())
}

impl Brain {
    pub fn new(net: Net, db: CardDb, cfg: PlayCfg) -> Brain {
        Brain { net, db, cfg, dev: Device::flex() }
    }

    pub fn score(&self, msg: &Value) -> Scored {
        let enc = encode(msg, &self.db);
        let n = enc.actions.len();
        let s = Tensor::<2>::from_data(TensorData::new(enc.state.clone(), [1, STATE_DIM]), &self.dev).repeat_dim(0, n);
        let a = Tensor::<2>::from_data(TensorData::new(enc.actions.concat(), [n, ACTION_DIM]), &self.dev);
        let ids = Tensor::<1, Int>::from_data(TensorData::new(enc.ids.clone(), [n]), &self.dev);
        let out = self.net.forward(s, a, ids);
        let q: Vec<f32> = out.q.into_data().try_to_vec::<f32>().unwrap();
        let v_now = sigmoid(out.v.into_data().try_to_vec::<f32>().unwrap()[0]);
        let delta: Vec<f32> = out.world.into_data().try_to_vec::<f32>().unwrap();
        // predicted next state = current state with the world block moved by the predicted change
        let mut next = Vec::with_capacity(n * STATE_DIM);
        let mut h_next = Vec::with_capacity(n);
        for k in 0..n {
            let mut st = enc.state.clone();
            for j in 0..WORLD_DIM {
                st[j] += delta[k * WORLD_DIM + j];
            }
            h_next.push(heuristic(&st[..WORLD_DIM]));
            next.extend(st);
        }
        let v_next: Vec<f32> = if self.cfg.world != 0.0 {
            let t = Tensor::<2>::from_data(TensorData::new(next, [n, STATE_DIM]), &self.dev);
            self.net.value(t).into_data().try_to_vec::<f32>().unwrap()
        } else {
            vec![0.0; n]
        };
        let score = (0..n).map(|k| q[k] + self.cfg.world * v_next[k] + self.cfg.heur * h_next[k]).collect();
        Scored { q, v_now, v_next, h_next, score }
    }
}

struct Rng(u64);
impl Rng {
    fn next_f32(&mut self) -> f32 {
        self.0 = self.0.wrapping_add(0x9E3779B97F4A7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58476D1CE4E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D049BB133111EB);
        ((z ^ (z >> 31)) >> 40) as f32 / (1u64 << 24) as f32
    }
}

fn pick(score: &[f32], banned: &[usize], cfg: &PlayCfg, rng: &mut Rng) -> usize {
    let allowed: Vec<usize> = (0..score.len()).filter(|i| !banned.contains(i)).collect();
    let allowed = if allowed.is_empty() { (0..score.len()).collect() } else { allowed };
    if cfg.epsilon > 0.0 && rng.next_f32() < cfg.epsilon {
        return allowed[(rng.next_f32() * allowed.len() as f32) as usize % allowed.len()];
    }
    if cfg.temp > 0.0 {
        let m = allowed.iter().map(|&i| score[i]).fold(f32::MIN, f32::max);
        let w: Vec<f32> = allowed.iter().map(|&i| ((score[i] - m) / cfg.temp).exp()).collect();
        let mut r = rng.next_f32() * w.iter().sum::<f32>();
        for (k, &i) in allowed.iter().enumerate() {
            r -= w[k];
            if r <= 0.0 {
                return i;
            }
        }
        return *allowed.last().unwrap();
    }
    // argmax, ties broken at random
    let best = allowed.iter().map(|&i| score[i]).fold(f32::MIN, f32::max);
    let ties: Vec<usize> = allowed.iter().copied().filter(|&i| score[i] >= best - 1e-6).collect();
    ties[(rng.next_f32() * ties.len() as f32) as usize % ties.len()]
}

fn write_thoughts(path: &std::path::Path, msg: &Value, sc: &Scored, chosen: usize) {
    let actions = msg["actions"].as_array().cloned().unwrap_or_default();
    let mut order: Vec<usize> = (0..sc.score.len()).collect();
    order.sort_by(|a, b| sc.score[*b].partial_cmp(&sc.score[*a]).unwrap_or(std::cmp::Ordering::Equal));
    let top: Vec<Value> = order
        .iter()
        .take(8)
        .map(|&i| {
            let a = &actions[i];
            let name = a["card"]["n"].as_str().map(String::from).unwrap_or_else(|| a["label"].as_str().unwrap_or("?").to_string());
            json!({"i": i, "label": format!("{} {}", a["kind"].as_str().unwrap_or(""), name),
                   "pWin": sigmoid(sc.q[i]), "vNext": sigmoid(sc.v_next[i]), "heur": sc.h_next[i], "score": sc.score[i], "chosen": i == chosen})
        })
        .collect();
    let out = json!({
        "seq": msg["seq"], "you": msg["you"], "round": msg["state"]["round"],
        "prompt": msg["prompt"]["title"], "vNow": sc.v_now, "top": top, "state": msg["state"],
    });
    let tmp = path.with_extension("tmp");
    if std::fs::write(&tmp, out.to_string()).is_ok() {
        let _ = std::fs::rename(&tmp, path);
    }
}

pub fn run(brain: Brain, name: &str) {
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout().lock();
    let mut rng = Rng(1);
    // how often this exact observation came up in this game, and what we picked each time
    let mut seen: HashMap<u64, Vec<usize>> = HashMap::new();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let msg: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(e) => {
                writeln!(stdout, "{}", json!({"t": "error", "error": format!("bad json: {e}")})).unwrap();
                stdout.flush().unwrap();
                continue;
            }
        };
        let reply = match msg["t"].as_str() {
            Some("hello") => {
                rng = Rng(msg["seed"].as_u64().unwrap_or(1));
                seen.clear();
                json!({"t": "ready", "v": 1, "name": name})
            }
            Some("decide") => {
                let n = msg["actions"].as_array().map(|a| a.len()).unwrap_or(0);
                if n <= 1 {
                    json!({"t": "act", "i": 0})
                } else {
                    let sc = brain.score(&msg);
                    // loop guard: if this exact observation keeps coming back, stop repeating the same choices
                    let key = {
                        use std::hash::{Hash, Hasher};
                        let mut h = std::collections::hash_map::DefaultHasher::new();
                        msg["state"].to_string().hash(&mut h);
                        msg["prompt"].to_string().hash(&mut h);
                        h.finish()
                    };
                    let prev = seen.entry(key).or_default();
                    let banned: Vec<usize> = if prev.len() >= 2 { prev.clone() } else { vec![] };
                    let i = pick(&sc.score, &banned, &brain.cfg, &mut rng);
                    prev.push(i);
                    if let Some(p) = &brain.cfg.thoughts {
                        write_thoughts(p, &msg, &sc, i);
                    }
                    json!({"t": "act", "i": i})
                }
            }
            _ => continue,
        };
        writeln!(stdout, "{reply}").unwrap();
        stdout.flush().unwrap();
    }
}
