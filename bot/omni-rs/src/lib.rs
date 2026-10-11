//! Deterministic perfect-information rules for the explicitly supported SWU subset.
pub mod model;
pub mod search;
pub mod simulator;
pub use model::{Action, Seat, State};
pub use simulator::Engine;
pub mod ability_ir;
pub mod check;
pub mod validation;
