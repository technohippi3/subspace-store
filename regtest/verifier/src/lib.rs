//! Shared helpers for the regtest verifier and the regtest record tool.
//!
//! Regtest harness tooling. A result from it is a regtest result.

use libveritas::msg::Message;
use libveritas::sip7::{Record, RecordSet};
use libveritas::spaces_protocol::sname::SName;
use serde_json::{json, Value};

/// Decode a SIP-7 record set for printing and comparison. A set that
/// doesn't decode is reported as such, with its bytes.
pub fn records_json(set: &RecordSet) -> Value {
    match set.unpack_owned() {
        Ok(records) => Value::Array(records.iter().map(record_json).collect()),
        Err(e) => json!({ "undecodable": e.to_string(), "hex": hex::encode(set.as_slice()) }),
    }
}

fn record_json(r: &Record) -> Value {
    match r {
        Record::Seq(n) => json!({ "type": "seq", "value": n }),
        Record::Txt { key, value } => json!({ "type": "txt", "key": key, "values": value }),
        Record::Addr { key, value } => json!({ "type": "addr", "key": key, "values": value }),
        Record::Blob { key, value } => json!({ "type": "blob", "key": key, "hex": hex::encode(value) }),
        Record::Sig { flags, canonical, handle, sig } => json!({
            "type": "sig", "flags": flags, "canonical": canonical.to_string(),
            "handle": handle.to_string(), "sig": hex::encode(sig),
        }),
        Record::Unknown { rtype, rdata } => json!({ "type": "unknown", "rtype": rtype, "hex": hex::encode(rdata) }),
    }
}

/// Unsigned records from a JSON list such as
/// `[{"seq": 1}, {"txt": "note", "values": ["hello"]}]`.
pub fn records_from_json(v: &Value) -> Result<RecordSet, String> {
    let items = v.as_array().ok_or("records must be a JSON list")?;
    let mut out = Vec::new();
    for item in items {
        if let Some(n) = item.get("seq") {
            out.push(Record::seq(n.as_u64().ok_or("seq must be a number")?));
        } else if let Some(k) = item.get("txt") {
            let key = k.as_str().ok_or("txt must be a string")?;
            let values: Vec<&str> = item
                .get("values")
                .and_then(Value::as_array)
                .ok_or("txt needs values")?
                .iter()
                .map(|s| s.as_str().ok_or("values must be strings"))
                .collect::<Result<_, _>>()?;
            out.push(Record::txt(key, &values));
        } else {
            return Err(format!("unsupported record: {item}"));
        }
    }
    RecordSet::pack(out).map_err(|e| e.to_string())
}

/// The names for which a message carries an owner-signed record set, before
/// verification. libveritas drops a set whose signature doesn't verify
/// against the zone's key without failing the message, so a set carried
/// here and missing from the verified zone was dropped.
pub fn carried_records(msg: &Message) -> Vec<(SName, RecordSet)> {
    let mut out = Vec::new();
    for bundle in &msg.spaces {
        if let Some(r) = &bundle.records {
            out.push((SName::from_space(&bundle.subject), r.clone()));
        }
        for epoch in &bundle.epochs {
            for h in &epoch.handles {
                if let (Some(r), Ok(name)) = (&h.records, SName::join(&h.name, &bundle.subject)) {
                    out.push((name, r.clone()));
                }
            }
        }
    }
    out
}
