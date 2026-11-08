//! Sign records for a handle on regtest, as a client publishing them would.
//!
//! Usage:
//!   subspace-regtest-records keygen <key-file>
//!   subspace-regtest-records sign <message.bin> <anchors.json> <handle> <records.json> <key-file> <out.bin>
//!
//! `keygen` makes a fresh BIP-340 key from the OS's randomness, writes its
//! secret in hex to `key-file` (created new, mode 0600) and prints the P2TR
//! script_pubkey whose output key is that key. It is a regtest buyer key for
//! a run's own handle: the file stays in the run's working directory, never
//! in kept evidence, and the harness deletes it when the run ends.
//!
//! `sign` verifies `message.bin` (a certificate message for the handle, from
//! `subs` or from a relay's `/query` answer) against `anchors.json` with
//! libveritas, takes the handle's certificates from it, and builds a new
//! message for the handle carrying `records.json` signed with the key, using
//! the verified message's own chain proof. It writes the message to
//! `out.bin`, ready for a relay's `/message`, and prints the signing id. The
//! records are signed even if the key isn't the handle's: a relay or a
//! verifier must refuse those, and the harness checks that it does.
//!
//! Regtest harness tooling. A result from it is a regtest result.

use std::io::{Read, Write};
use std::os::unix::fs::OpenOptionsExt;

use libveritas::builder::MessageBuilder;
use libveritas::cert::CertificateChain;
use libveritas::msg::{Message, QueryContext};
use libveritas::spaces_protocol::bitcoin::secp256k1::{Keypair, Message as Digest, Secp256k1};
use libveritas::spaces_protocol::sname::SName;
use libveritas::{Veritas, VERIFY_DEFAULT};
use spaces_nums::RootAnchor;
use subspace_regtest_verifier::records_from_json;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("keygen") if args.len() == 3 => keygen(&args[2]),
        Some("sign") if args.len() == 8 => sign(&args[2..]),
        _ => {
            eprintln!(
                "usage: {0} keygen <key-file>\n       {0} sign <message.bin> <anchors.json> <handle> <records.json> <key-file> <out.bin>",
                args[0]
            );
            std::process::exit(2);
        }
    }
}

fn keygen(path: &str) {
    let secp = Secp256k1::new();
    let keypair = loop {
        let mut secret = [0u8; 32];
        std::fs::File::open("/dev/urandom")
            .and_then(|mut f| f.read_exact(&mut secret))
            .unwrap_or_else(|e| fail(&format!("no randomness: {e}")));
        if let Ok(k) = Keypair::from_seckey_slice(&secp, &secret) {
            break k;
        }
    };
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .unwrap_or_else(|e| fail(&format!("key file: {e}")));
    f.write_all(hex::encode(keypair.secret_bytes()).as_bytes())
        .unwrap_or_else(|e| fail(&format!("key file: {e}")));
    let (xonly, _) = keypair.x_only_public_key();
    println!(
        "{}",
        serde_json::json!({ "script_pubkey": format!("5120{}", hex::encode(xonly.serialize())) })
    );
}

fn sign(a: &[String]) {
    let (msg_path, anchors_path, handle, records_path, key_path, out_path) =
        (&a[0], &a[1], &a[2], &a[3], &a[4], &a[5]);
    let handle = SName::try_from(handle.as_str()).unwrap_or_else(|_| fail("bad handle"));
    let space = SName::from_space(&handle.space().unwrap_or_else(|| fail("handle has no space")));

    let anchors: Vec<RootAnchor> = serde_json::from_str(&read_text(anchors_path))
        .unwrap_or_else(|e| fail(&format!("anchors: {e}")));
    let veritas = Veritas::new()
        .with_anchors(anchors)
        .unwrap_or_else(|e| fail(&format!("anchors rejected: {e:?}")));
    let msg = Message::from_slice(&read_bytes(msg_path))
        .unwrap_or_else(|e| fail(&format!("message does not decode: {e}")));
    let verified = veritas
        .verify_with_options(&QueryContext::new(), msg, VERIFY_DEFAULT)
        .unwrap_or_else(|e| fail(&format!("verification failed: {e:?}")));
    if !verified.zones.iter().any(|z| z.handle == handle) {
        fail("the message has no verified zone for the handle");
    }
    let certs: Vec<_> = verified
        .certificates()
        .filter(|c| c.subject == handle || c.subject == space)
        .collect();

    let records_json: serde_json::Value = serde_json::from_str(&read_text(records_path))
        .unwrap_or_else(|e| fail(&format!("records: {e}")));
    let records = records_from_json(&records_json).unwrap_or_else(|e| fail(&e));

    let mut builder = MessageBuilder::new();
    builder.add_handle(CertificateChain::new(handle.clone(), certs), records);
    let (mut message, unsigned) = builder
        .build(verified.message.chain.clone())
        .unwrap_or_else(|e| fail(&format!("build failed: {e:?}")));

    let secp = Secp256k1::new();
    let secret = hex::decode(read_text(key_path).trim()).unwrap_or_else(|_| fail("key file is not hex"));
    let keypair = Keypair::from_seckey_slice(&secp, &secret).unwrap_or_else(|_| fail("bad key"));
    let mut ids = Vec::new();
    for u in &unsigned {
        let id = u.signing_id();
        let sig = secp.sign_schnorr_no_aux_rand(&Digest::from_digest(id), &keypair);
        message.set_records(&u.canonical, u.pack_sig(sig.serialize().to_vec()));
        ids.push(hex::encode(id));
    }
    std::fs::write(out_path, message.to_bytes()).unwrap_or_else(|e| fail(&format!("write: {e}")));
    println!("{}", serde_json::json!({ "signed": true, "signing_ids": ids }));
}

fn read_text(p: &str) -> String {
    std::fs::read_to_string(p).unwrap_or_else(|e| fail(&format!("{p}: {e}")))
}

fn read_bytes(p: &str) -> Vec<u8> {
    std::fs::read(p).unwrap_or_else(|e| fail(&format!("{p}: {e}")))
}

fn fail(reason: &str) -> ! {
    println!("{}", serde_json::json!({ "signed": false, "error": reason }));
    std::process::exit(1);
}
