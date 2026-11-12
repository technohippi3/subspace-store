//! Offline format investigation. This does not claim compatibility with a phone app.
use libveritas::builder::MessageBuilder;
use libveritas::cert::{Certificate, CertificateChain};
use libveritas::msg::{Message, QueryContext};
use libveritas::spaces_protocol::sname::SName;
use libveritas::{ProvableOption, SovereigntyState, Veritas, Zone, VERIFY_DEFAULT};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::Path;

fn hex(bytes: &[u8]) -> String { bytes.iter().map(|b| format!("{b:02x}")).collect() }
fn facts(zones: &[Zone], subject: &SName, root: &SName) -> BTreeMap<String, Value> {
    zones.iter().filter(|z| &z.handle == subject || &z.handle == root).map(|z| {
        let commitment = match &z.commitment {
            ProvableOption::Exists { value } => json!({"root": hex(&value.onchain.state_root), "height": value.onchain.block_height}),
            _ => Value::Null,
        };
        (z.handle.to_string(), json!({"canonical":z.canonical.to_string(), "script_pubkey":hex(z.script_pubkey.as_bytes()),
          "sovereignty":z.sovereignty.to_string(), "anchor":z.anchor, "anchor_hash":hex(&z.anchor_hash), "commitment":commitment}))
    }).collect()
}
fn native(args: &[String]) -> Result<Value, String> {
    if args.len() != 9 { return Err("usage: native <message> <anchors> <handle> <expected-script> <expected-root> <expected-root-height> <new-output-directory>".into()); }
    let raw = std::fs::read(&args[2]).map_err(|e| e.to_string())?;
    let anchors = serde_json::from_slice(&std::fs::read(&args[3]).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let verifier = Veritas::new().with_anchors(anchors).map_err(|e| format!("anchors rejected: {e:?}"))?;
    let subject: SName = args[4].parse().map_err(|_| "invalid requested handle")?;
    let root = SName::from_space(&subject.space().ok_or("handle has no space")?);
    let message = Message::from_slice(&raw).map_err(|e| format!("message decoding failed: {e}"))?;
    let verified = verifier.verify_with_options(&QueryContext::new(), message, VERIFY_DEFAULT).map_err(|e| format!("verification failed: {e:?}"))?;
    let zone = verified.zones.iter().find(|z| z.handle == subject).ok_or("requested handle was not verified")?;
    if zone.sovereignty != SovereigntyState::Sovereign { return Err("requested handle is not sovereign".into()); }
    if hex(zone.script_pubkey.as_bytes()) != args[5] { return Err("verified recipient does not match expected recipient".into()); }
    let expected_height: u32 = args[7].parse().map_err(|_| "invalid expected commitment height")?;
    let root_zone = verified.zones.iter().find(|z| z.handle == root).ok_or("root zone was not verified")?;
    match &root_zone.commitment {
        ProvableOption::Exists { value } if hex(&value.onchain.state_root) == args[6] && value.onchain.block_height == expected_height => {},
        _ => return Err("verified commitment does not match expected root and height".into()),
    }
    let certificates: Vec<Certificate> = verified.certificates().filter(|c| c.subject == subject || c.subject == root).collect();
    if certificates.len() != 2 || certificates.iter().any(|c| !c.is_final()) { return Err("expected exactly a final root and final leaf certificate".into()); }
    // Exercise the official human-readable serde encoding as well as the
    // official SCRT container. No ad-hoc legacy witness encoding is supplied.
    let json_bytes = serde_json::to_vec_pretty(&certificates).map_err(|e| e.to_string())?;
    let from_json: Vec<Certificate> = serde_json::from_slice(&json_bytes).map_err(|e| e.to_string())?;
    for (a,b) in certificates.iter().zip(from_json.iter()) {
        if a.to_bytes() != b.to_bytes() { return Err("native serde round trip changed a certificate".into()); }
    }
    let chain = CertificateChain::new(subject.clone(), from_json);
    let encoded = chain.to_bytes();
    let decoded = CertificateChain::from_slice(&encoded).map_err(|e| e.to_string())?;
    if decoded.subject() != &subject || decoded.to_bytes() != encoded { return Err("SCRT round trip differs".into()); }
    let mut builder = MessageBuilder::new(); builder.add_chain(decoded);
    // Use only the saved independently anchored on-chain proof. No wallet,
    // network, relay or fresh proof request is made by this investigation.
    let (rebuilt, unsigned) = builder.build(verified.message.chain.clone()).map_err(|e| format!("rebuild failed: {e:?}"))?;
    if !unsigned.is_empty() { return Err("unexpected unsigned data".into()); }
    let bytes = rebuilt.to_bytes();
    let rebuilt = Message::from_slice(&bytes).map_err(|e| e.to_string())?;
    let round_trip = verifier.verify_with_options(&QueryContext::new(), rebuilt, VERIFY_DEFAULT).map_err(|e| format!("round-trip verification failed: {e:?}"))?;
    let before = facts(&verified.zones, &subject, &root);
    if before != facts(&round_trip.zones, &subject, &root) { return Err("round trip changed verification facts".into()); }
    let output = Path::new(&args[8]);
    std::fs::create_dir(output).map_err(|e| format!("new output directory required: {e}"))?;
    std::fs::write(output.join("certificate.spacecert"), &encoded).map_err(|e| e.to_string())?;
    std::fs::write(output.join("native-certificates.json"), &json_bytes).map_err(|e| e.to_string())?;
    std::fs::write(output.join("roundtrip.spacemsg"), &bytes).map_err(|e| e.to_string())?;
    let report = json!({"verified":true,"format":"libveritas-0.4.4-native","nacho_32a1d_import_qualified":false,
       "default_verification_options":VERIFY_DEFAULT,"certificate_count":certificates.len(),"spacecert_bytes":encoded.len(),
       "message_bytes":raw.len(),"roundtrip_message_bytes":bytes.len(),"verified_facts":before});
    std::fs::write(output.join("verification.json"), serde_json::to_vec_pretty(&report).unwrap()).map_err(|e| e.to_string())?;
    Ok(report)
}
fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("qr") {
        use std::io::Read;
        let mut url = String::new();
        if args.len() != 2 || std::io::stdin().take(2049).read_to_string(&mut url).is_err() || url.is_empty() || url.len() > 2048 {
            eprintln!("bounded QR URL on stdin required"); std::process::exit(2);
        }
        let code = qrcode::QrCode::with_error_correction_level(url.as_bytes(), qrcode::EcLevel::M).expect("bounded URL fits QR");
        println!("{}", code.render::<qrcode::render::svg::Color>().min_dimensions(256,256).build());
        return;
    }
    if args.get(1).map(String::as_str) == Some("legacy-nacho-32a1d") {
        eprintln!("refused: pinned public Nacho has no semantic decoder/verifier for its opaque anchor/subtree strings; no verified conversion is defined");
        std::process::exit(3);
    }
    if args.get(1).map(String::as_str) != Some("native") { eprintln!("select an explicit supported profile: native; legacy-nacho-32a1d is unsupported"); std::process::exit(2); }
    match native(&args) { Ok(report) => println!("{}", report), Err(error) => { eprintln!("{error}"); std::process::exit(1); } }
}
