//! Deterministic perfect-information rules for the explicitly supported SWU subset.
pub mod model;
pub mod search;
pub mod simulator;
pub use model::{Action, Seat, State};
pub use simulator::{Engine, RulesBackend};
pub mod ability_ir;
pub mod check;
pub mod validation;

fn program_backend(bytes:&[u8])->Result<usize,&'static str> {
    use sha2::{Digest,Sha256};
    simulator::program_backend(&format!("{:x}",Sha256::digest(bytes)),bytes)
}

fn expression_backend(bytes: &[u8]) -> Option<usize> {
    use sha2::{Digest, Sha256};
    simulator::expression_backend(&format!("{:x}", Sha256::digest(bytes)), bytes)
}
