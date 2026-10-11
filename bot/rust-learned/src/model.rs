//! The tiny model: a state encoder shared by three heads.
//!
//! - value head      V(s)      -> logit of "I win from here"
//! - action head     Q(s, a)   -> logit of "I win if I take a here"   (the action model)
//! - prior head      P(s, a)   -> logit of "a teacher bot would pick a here" (trained by `train-prior`: on
//!                                frozen features it never moves Q; with `--full` the whole network imitates
//!                                and the Q, V and world heads no longer match the encoder)
//! - world head      W(s, a)   -> predicted change of the board block of the state
//!                                by my next decision (the world model)
//!
//! About 94k parameters (a third of them the card embedding). Small enough to train on a laptop CPU in minutes and to run in well under a
//! millisecond per decision.

use crate::features::{ACTION_DIM, ID_BUCKETS, STATE_DIM, WORLD_DIM};
use burn::nn::{Dropout, DropoutConfig, Embedding, EmbeddingConfig, Linear, LinearConfig, Relu};
use burn::prelude::*;

pub const HIDDEN: usize = 128;
pub const EMB: usize = 16;

#[derive(Module, Debug)]
pub struct Net {
    s1: Linear,
    s2: Linear,
    emb: Embedding,
    a1: Linear,
    j1: Linear,
    q: Linear,
    world: Linear,
    v: Linear,
    p1: Linear,
    p2: Linear,
    act: Relu,
    drop: Dropout,
}

pub struct Out {
    pub q: Tensor<2>,
    pub v: Tensor<2>,
    pub world: Tensor<2>,
    pub prior: Tensor<2>,
}

impl Net {
    pub fn new(device: &Device) -> Net {
        Net {
            s1: LinearConfig::new(STATE_DIM, HIDDEN).init(device),
            s2: LinearConfig::new(HIDDEN, HIDDEN).init(device),
            emb: EmbeddingConfig::new(ID_BUCKETS, EMB).init(device),
            a1: LinearConfig::new(ACTION_DIM + EMB, HIDDEN / 2).init(device),
            j1: LinearConfig::new(HIDDEN + HIDDEN / 2, HIDDEN).init(device),
            q: LinearConfig::new(HIDDEN, 1).init(device),
            world: LinearConfig::new(HIDDEN, WORLD_DIM).init(device),
            v: LinearConfig::new(HIDDEN, 1).init(device),
            p1: LinearConfig::new(HIDDEN, HIDDEN / 2).init(device),
            p2: LinearConfig::new(HIDDEN / 2, 1).init(device),
            act: Relu::new(),
            drop: DropoutConfig::new(0.2).init(),
        }
    }

    /// `state` [B, STATE_DIM], `action` [B, ACTION_DIM], `ids` [B] (hashed card/label identity).
    pub fn forward(&self, state: Tensor<2>, action: Tensor<2>, ids: Tensor<1, Int>) -> Out {
        let (z, j) = self.encode(state, action, ids);
        let prior = self.prior_head(j.clone().detach());
        Out { q: self.q.forward(j.clone()), v: self.v.forward(z), world: self.world.forward(j), prior }
    }

    /// State encoding z and joint state-action features j.
    pub fn encode(&self, state: Tensor<2>, action: Tensor<2>, ids: Tensor<1, Int>) -> (Tensor<2>, Tensor<2>) {
        let z = self.act.forward(self.s1.forward(state));
        let z = self.drop.forward(self.act.forward(self.s2.forward(z)));
        let b = ids.dims()[0];
        let e: Tensor<2> = self.emb.forward(ids.reshape([b, 1])).reshape([b, EMB]);
        let a = self.act.forward(self.a1.forward(Tensor::cat(vec![action, e], 1)));
        let j = self.drop.forward(self.act.forward(self.j1.forward(Tensor::cat(vec![z.clone(), a], 1))));
        (z, j)
    }

    /// The teacher-prior logit from joint features.
    pub fn prior_head(&self, j: Tensor<2>) -> Tensor<2> {
        self.p2.forward(self.act.forward(self.p1.forward(j)))
    }

    /// Value of bare states (used to score world-model predictions).
    pub fn value(&self, state: Tensor<2>) -> Tensor<2> {
        let z = self.act.forward(self.s1.forward(state));
        let z = self.act.forward(self.s2.forward(z));
        self.v.forward(z)
    }
}
