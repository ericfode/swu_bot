//! Policies: given one decision, return the index of the action to take.

mod greedy;
mod greedy2;
mod random;

use crate::cards::CardDb;
use crate::protocol::{Decide, DistShare, Hello};

pub trait Policy {
    /// A new game starts (protocol `hello`): reset per-game state and reseed.
    fn new_game(&mut self, hello: &Hello);
    fn choose(&mut self, req: &Decide) -> usize;
    /// When the chosen action is a `distribute`, the split to send with it (None: the engine side picks one).
    fn distribution(&mut self, _req: &Decide, _i: usize) -> Option<Vec<DistShare>> {
        None
    }
}

pub const NAMES: &[&str] = &["random", "greedy", "greedy2"];

pub fn create(name: &str) -> Option<Box<dyn Policy>> {
    match name {
        "random" => Some(Box::new(random::Random::default())),
        "greedy" => Some(Box::new(greedy::Greedy::default())),
        // card data is read once per process; the bot process serves many games
        "greedy2" => Some(Box::new(greedy2::Greedy2::new(Box::leak(Box::new(CardDb::load_default()))))),
        _ => None,
    }
}

/// splitmix64: tiny, seedable, good enough for tie-breaks and random play.
#[derive(Default)]
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
