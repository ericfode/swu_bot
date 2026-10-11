use super::{Policy, Rng};
use crate::protocol::{Decide, Hello};

/// Uniform random over legal actions, seeded from the game's `hello`, so a seed always plays the same game.
#[derive(Default)]
pub struct Random {
    rng: Rng,
}

impl Policy for Random {
    fn new_game(&mut self, hello: &Hello) {
        self.rng.seed(hello.seed);
    }

    fn choose(&mut self, req: &Decide) -> usize {
        self.rng.below(req.actions.len())
    }
}
