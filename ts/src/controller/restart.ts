import { ControllerError, refuse } from "./errors.ts";
import type { BatchDatabase } from "./database.ts";
import { latest, type ControllerJournal } from "./journal.ts";
import { sameIdentity, sameIntent, sent, type Batch } from "./records.ts";

export function appendIfAvailable(journal: ControllerJournal, value: Batch): void {
  try { journal.append(value); }
  catch (error) { if (error instanceof ControllerError && error.code !== "unavailable") throw error; }
}
/** Startup never contacts the registry or native ports and never authorizes a send. */
export function settleRestart(db: BatchDatabase, journal: ControllerJournal): void {
  let acknowledged: Map<string, Batch> | undefined;
  try { acknowledged = latest(journal.entries()); }
  catch (error) { if (error instanceof ControllerError && error.code !== "unavailable") throw error; }
  db.requireRestored(new Set(acknowledged?.keys()));
  // Validate all immutable identities before changing any older local row.
  for (const b of db.batches()) {
    const acked = acknowledged?.get(b.bid);
    if (acked && (!sameIdentity(b, acked) || b.entry_key && acked.entry_key && b.entry_key !== acked.entry_key))
      refuse("controller batch binding differs from journal; reconcile before continuing");
    if (acked && b.state === "issuing" && acked.state === "issuing" && b.entry_key === acked.entry_key && !sameIntent(b, acked))
      refuse("controller issuance intent differs from journal; reconcile before continuing");
  }
  for (let b of db.batches()) {
    const acked = acknowledged?.get(b.bid);
    if (acked && ["checkpointed", "issuing", "broadcast_uncertain"].includes(b.state)) {
      if (sent.includes(acked.state) && acked.state !== b.state) { db.adopt(acked); b = db.get(b.bid); }
      else if (b.state === "checkpointed" && acked.entry_key &&
          (acked.state !== "checkpointed" || b.entry_key !== acked.entry_key)) {
        if (!["checkpointed", "issuing"].includes(acked.state)) refuse("controller entry requires release/rebuild recovery", "release_required");
        db.adopt(acked); b = db.get(b.bid);
        if (acked.state === "issuing") b = db.uncertain(b.bid, "older controller database lost the local attempted-send evidence", "journaled intent after older database");
      }
    }
    if (b.state === "issuing" && (b.attempted || acked?.attempted)) b = db.uncertain(b.bid, "interrupted before an answer was recorded", "interrupted commitment attempt");
    if (b.state === "broadcast_uncertain") appendIfAvailable(journal, b);
  }
}
