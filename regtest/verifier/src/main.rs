//! Verify a certificate message offline with libveritas.
//!
//! Usage: subspace-regtest-verifier <message.bin> <anchors.json>
//!
//! `message.bin` is the borsh-encoded message `subs` builds for a handle.
//! `anchors.json` is the output of `spaced`'s `getrootanchors`, read from
//! `spaced` directly rather than through `subs`. The message is verified with
//! the default options: no dev-mode receipts and no SNARKs. The verified
//! zones are printed as JSON, and the caller compares them with what it
//! expects (handle, script_pubkey, commitment root and sovereignty).
//!
//! Regtest harness tooling. A result from it is a regtest result.

use libveritas::msg::{Message, QueryContext};
use libveritas::{ProvableOption, Veritas, VERIFY_DEFAULT};
use spaces_nums::RootAnchor;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 3 {
        eprintln!("usage: {} <message.bin> <anchors.json>", args[0]);
        std::process::exit(2);
    }
    let msg_bytes = std::fs::read(&args[1]).expect("read message");
    let anchors_json = std::fs::read_to_string(&args[2]).expect("read anchors");
    let anchors: Vec<RootAnchor> = serde_json::from_str(&anchors_json).expect("parse anchors");

    let veritas = match Veritas::new().with_anchors(anchors) {
        Ok(v) => v,
        Err(e) => fail(&format!("anchors rejected: {:?}", e)),
    };
    let msg = match Message::from_slice(&msg_bytes) {
        Ok(m) => m,
        Err(e) => fail(&format!("message does not decode: {}", e)),
    };
    let verified = match veritas.verify_with_options(&QueryContext::new(), msg, VERIFY_DEFAULT) {
        Ok(v) => v,
        Err(e) => fail(&format!("verification failed: {:?}", e)),
    };

    let zones: Vec<serde_json::Value> = verified
        .zones
        .iter()
        .map(|z| {
            let (root, height) = match &z.commitment {
                ProvableOption::Exists { value } => (
                    Some(hex::encode(value.onchain.state_root)),
                    Some(value.onchain.block_height),
                ),
                _ => (None, None),
            };
            serde_json::json!({
                "handle": z.handle.to_string(),
                "canonical": z.canonical.to_string(),
                "script_pubkey": hex::encode(z.script_pubkey.as_bytes()),
                "sovereignty": z.sovereignty.to_string(),
                "anchor": z.anchor,
                "commitment_root": root,
                "commitment_height": height,
            })
        })
        .collect();
    let certs: Vec<serde_json::Value> = verified
        .certificates()
        .map(|c| serde_json::json!({
            "subject": c.subject.to_string(),
            "final": c.is_final(),
            "temporary": c.is_temporary(),
        }))
        .collect();
    println!(
        "{}",
        serde_json::json!({
            "verified": true,
            "newest_anchor": veritas.newest_anchor(),
            "zones": zones,
            "certificates": certs,
        })
    );
}

fn fail(reason: &str) -> ! {
    println!("{}", serde_json::json!({ "verified": false, "error": reason }));
    std::process::exit(1);
}
