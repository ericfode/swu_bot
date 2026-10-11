//! Policies: given one decision, return the index of the action to take.

mod greedy;
mod greedy2;
mod random;
mod search;

use crate::cards::CardDb;
use crate::protocol::{Decide, DistShare, Hello, Simulated};

/// One v2 `sim` request.
pub enum SimOp {
    /// Start from the real position with hidden cards dealt again; the same deal number gives the same cards.
    Begin(Option<u32>),
    /// Play action `i` of the last position (for whichever seat must act), with a split for `distribute`.
    Act(usize, Option<Vec<DistShare>>),
    End,
}

impl SimOp {
    pub fn name(&self) -> &'static str {
        match self {
            SimOp::Begin(_) => "begin",
            SimOp::Act(..) => "act",
            SimOp::End => "end",
        }
    }
}

/// v2 simulations: send one `sim` request and get its `simulated` reply (with `error` set when it failed).
pub trait Simulator {
    fn sim(&mut self, op: SimOp) -> Simulated;
}

pub trait Policy {
    /// A new game starts (protocol `hello`): reset per-game state and reseed.
    fn new_game(&mut self, hello: &Hello);
    fn choose(&mut self, req: &Decide) -> usize;
    /// When the chosen action is a `distribute`, the split to send with it (None: the engine side picks one).
    fn distribution(&mut self, _req: &Decide, _i: usize) -> Option<Vec<DistShare>> {
        None
    }
    /// Ask for simulations in `ready` (v2 referees only).
    fn wants_sim(&self) -> bool {
        false
    }
    /// A decision where `sim` requests are allowed (v2, action windows, only if `wants_sim`).
    fn choose_sim(&mut self, req: &Decide, _sim: &mut dyn Simulator) -> usize {
        self.choose(req)
    }
}

pub const NAMES: &[&str] = &["random", "greedy", "greedy2", "search"];

pub fn create(name: &str) -> Option<Box<dyn Policy>> {
    match name {
        "random" => Some(Box::new(random::Random::default())),
        "greedy" => Some(Box::new(greedy::Greedy::default())),
        // card data is read once per process; the bot process serves many games
        "greedy2" => Some(Box::new(greedy2::Greedy2::new(Box::leak(Box::new(CardDb::load_default()))))),
        "search" => Some(Box::new(search::Search::new(Box::leak(Box::new(CardDb::load_default()))))),
        _ => None,
    }
}

/// splitmix64: tiny, seedable, good enough for tie-breaks and random play.
#[derive(Default, Clone)]
pub struct Rng(u64);

impl Rng {
    pub fn seed(&mut self, seed: u64) {
        self.0 = seed;
    }

    pub fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// Uniform in 0..n (n > 0).
    pub fn below(&mut self, n: usize) -> usize {
        (self.next_u64() % n as u64) as usize
    }
}
