//! Writes PUBLIC deterministic fixtures; this is not a signing-key utility.
#[path = "../tests/common/mod.rs"]
mod common;
use common::*;
use flex_scheduler::GENESIS;
use std::path::Path;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/phase1");
    std::fs::create_dir_all(&dir)?;
    let one = plan(1, GENESIS, 2);
    let two = plan(2, &one.manifest_hash, 1);
    for (name, json) in [
        ("config.json", serde_json::to_string_pretty(&config())?),
        ("plan-001.json", serde_json::to_string_pretty(&one)?),
        ("plan-002.json", serde_json::to_string_pretty(&two)?),
    ] {
        std::fs::write(dir.join(name), json + "\n")?;
    }
    println!("Wrote public phase-one fixtures");
    Ok(())
}
