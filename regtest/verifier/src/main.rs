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
//! Signed records are verified in the same call: libveritas attaches a
//! record set to a zone only if its embedded BIP-340 signature verifies
//! against the zone's current script_pubkey, for the zone's canonical name.
//! A set that fails is dropped without failing the message, so the output
//! lists, under `records`, each zone's verified records and whether the
//! message carried a set for it that was dropped. A verified record proves
//! only that the zone's key signed it; the caller compares the records with
//! what it expects.
//!
//! Regtest harness tooling. A result from it is a regtest result.

use libveritas::msg::{Message, QueryContext};
use libveritas::{ProvableOption, Veritas, VERIFY_DEFAULT};
use spaces_nums::RootAnchor;
use subspace_regtest_verifier::{carried_records, records_json};

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
    let carried = carried_records(&msg);
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
    let records: Vec<serde_json::Value> = verified
        .zones
        .iter()
        .map(|z| {
            let was_carried = carried.iter().any(|(name, _)| name == &z.canonical);
            serde_json::json!({
                "handle": z.handle.to_string(),
                "carried": was_carried,
                "dropped": was_carried && z.records.is_empty(),
                "verified": records_json(&z.records),
            })
        })
        .collect();
    println!(
        "{}",
        serde_json::json!({
            "verified": true,
            "newest_anchor": veritas.newest_anchor(),
            "zones": zones,
            "certificates": certs,
            "records": records,
        })
    );
}

fn fail(reason: &str) -> ! {
    println!("{}", serde_json::json!({ "verified": false, "error": reason }));
    std::process::exit(1);
}
