import { createHash, randomBytes } from "node:crypto";
import { Effect, Semaphore } from "effect";
import { canonicalHandle } from "../recipient.ts";
import { DurableStore, type StorageConfig } from "../storage/store.ts";
import { ApplicationError, checked, claims, decode, destination, fail, postIssuance, request, sats, verified,
  type Destination, type Order, type Record, type RefundSettings, type Snapshot, type State } from "./records.ts";
import { active, admission, grant, refresh, release, total } from "./sales.ts";
import { policy, type RefundPolicy } from "../refunds/policy.ts";
import { available, buildRequest, configuration, heldScripts, recordBuilt, reserve, summary } from "../refunds/book.ts";
import type { RefundAdapters, RefundGroup } from "../refunds/types.ts";
import { applyObservations, balance, refundStatus, sendable, settled, winner } from "../refunds/observations.ts";
import { allMembers, evidenceKey, members, preferred, reservation } from "../refunds/families.ts";
import { attemptRequest, finishAttempt, rebuildRequest, reserveAttempt } from "../refunds/attempts.ts";
import { advance, noteBroadcast, reconcile, recordLoss, tick, unserved, type Reason } from "./monitor.ts";
import { assess } from "./assessments.ts";
import { auditRecipients, recipientBlock } from "./entry.ts";
import { IssuanceRegistry, type RegistryContext } from "./registry.ts";
import { CertificateCache } from "./certificate-cache.ts";
import { certificateBytes, checkCertificates, type CertificateChain } from "./certificates.ts";
import { recoveryView } from "./deliveries.ts";
import { checkSupersessions, type SupersessionChain } from "./supersessions.ts";
import { persist } from "./persistence.ts";
import { inspectRecovered } from "./recovery.ts";
import { reconcileRecovered, type RecoveryController } from "./reconciliation.ts";

export interface Adapters {
  readonly clock: () => number;
  readonly snapshot: (destinations: readonly Destination[]) => Effect.Effect<Snapshot, ApplicationError>;
  readonly newDestination: Effect.Effect<Destination, ApplicationError>;
  readonly refunds?: RefundAdapters;
  readonly certificateChain?: CertificateChain;
  readonly supersessionChain?: SupersessionChain;
  readonly chainStatus?: Effect.Effect<{ network: string; best_block_hash: string; blocks: number }, ApplicationError>;
}
export interface Config extends StorageConfig { readonly riskBudgetSats: number;
  readonly refundPolicy: RefundPolicy; readonly merchantDestinations?: readonly Destination[] }
const hash = (token: string) => createHash("sha256").update(token).digest("hex");
/** One serialized application queue, including asynchronous wallet/chain work.
 * SQLite transactions cover only local writes; no RPC runs inside one. */
export class SalesStore {
  readonly registry: IssuanceRegistry;
  private readonly queue = Semaphore.makeUnsafe(1);
  private readonly storage: DurableStore;
  private readonly adapters: Adapters;
  private readonly budget: number;
  private readonly refunds: RefundSettings;
  private readonly registryContext: RegistryContext;
  private constructor(storage: DurableStore, adapters: Adapters, config: Config, certificateCache: CertificateCache) {
    this.storage = storage; this.adapters = adapters; this.budget = config.riskBudgetSats;
    this.refunds = configuration({ version: 1, policy: structuredClone(config.refundPolicy), merchantDestinations: structuredClone([...(config.merchantDestinations ?? [])]) });
    this.registryContext = { storage, certificateCache, ...(adapters.certificateChain ? { certificateChain: adapters.certificateChain } : {}),
      ...(adapters.supersessionChain ? { supersessionChain: adapters.supersessionChain } : {}),
      queue: this.queue, load: () => this.load(), refresh: () => this.refresh(), save: (before, state) => this.save(before, state) };
    this.registry = new IssuanceRegistry(this.registryContext);
  }
  static open(config: Config, adapters: Adapters) {
    return Effect.gen(function* () {
      yield* checked(() => { sats(config.riskBudgetSats); policy(config.refundPolicy); });
      const storage = yield* DurableStore.open(config);
      if ((yield* storage.status()).restoreRequired)
        return yield* checked(() => fail("restored application requires controller and chain reconciliation", "unavailable"));
      const cache = yield* verified(() => new CertificateCache(config.database + ".certificates"));
      const result = new SalesStore(storage, adapters, config, cache);
      const { records, state } = yield* result.load();
      if ((state.refundSends.length || state.refundObservations.length) && !adapters.refunds?.sender)
        return yield* checked(() => fail("refund reconciliation adapter is required", "unavailable"));
      yield* verified(() => auditRecipients(state));
      yield* result.save(records, state);
      if (state.supersessions.length || state.certificates.length || (adapters.refunds?.sender && state.groups.some(g => g.transaction))) yield* result.refresh();
      return result;
    });
  }
  static inspectRecovery(config: Config, adapters: Adapters) {
    return inspectRecovered(config, adapters, (storage, readOnly) => Effect.gen(function* () {
      const cache = yield* verified(() => new CertificateCache(config.database + ".certificates"));
      return yield* new SalesStore(storage, readOnly, config, cache).refresh(true);
    }));
  }
  static reconcileRecovery(config:Config,adapters:Adapters,controller:RecoveryController){
    return reconcileRecovered(config,adapters,controller,(storage,readOnly)=>Effect.gen(function*(){
      const cache=yield* verified(()=>new CertificateCache(config.database+".certificates"));
      return yield* new SalesStore(storage,readOnly,config,cache).refresh(true);
    }));
  }
  private load(recovery = false) {
    const self = this;
    return Effect.gen(function* () {
      const records = yield* self.storage.records();
      const state = yield* verified(() => decode(records, self.budget, self.refunds));
      if (state.recovery?.required && !recovery) return yield* checked(() => fail("restored application requires controller and chain reconciliation", "unavailable"));
      return { records, state };
    });
  }
  private save(before: readonly Record[], state: State) { return persist(this.storage, before, state, this.budget, this.refunds); }
  private refresh(recovery = false) {
    const self = this;
    return Effect.gen(function* () {
      const current = yield* self.load(recovery);
      const destinations = current.state.orders.flatMap(o => o.destination ? [{ ...o.destination }] : []);
      const transactions = allMembers(current.state).flatMap(m => m.transaction ? [m.transaction] : []), sender = self.adapters.refunds?.sender;
      if ((current.state.refundSends.length || current.state.refundObservations.length) && !sender)
        return yield* checked(() => fail("refund reconciliation adapter is required", "unavailable"));
      for (let attempt = 0; attempt < 3; attempt++) {
        const snapshot = yield* self.adapters.snapshot(destinations);
        if (sender && transactions.length) {
          const observations = yield* sender.observe(transactions);
          if (snapshot.tip !== observations.tip || snapshot.tipHash !== observations.tipHash) continue;
          yield* verified(() => applyObservations(current.state, observations));
        }
        yield* verified(() => refresh(current.state, self.adapters.clock(), snapshot));
        yield* checkSupersessions(current.state, snapshot, self.adapters.supersessionChain);
        yield* checkCertificates(current.state, snapshot, self.adapters.certificateChain);
        const observedAt = current.state.settings.lastTime;
        for (const fact of current.state.refundObservations) if (fact.seen !== "absent") noteBroadcast(current.state, fact.group, fact.txid, observedAt);
        const eligibleExcess = yield* assess(current.state, self.adapters.refunds, snapshot.tipHash, self.adapters.clock);
        yield* verified(() => reconcile(current.state, eligibleExcess, observedAt));
        yield* verified(() => auditRecipients(current.state));
        yield* self.save(current.records, current.state);
        return { ...(yield* self.load(recovery)), tipHash: snapshot.tipHash };
      }
      return yield* checked(() => fail("payment and refund observations disagree on the chain tip", "unavailable"));
    });
  }
  private find(state: State, token: string): Order {
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{32}$/.test(token)) fail("no such order", "not_found");
    const order = state.orders.find(o => o.tokenHash === hash(token));
    return order ?? fail("no such order", "not_found");
  }
  private recipient(state: State, order: Order): void {
    if (state.orders.some(o => o.destination?.script === order.recipient ||
        (o.handle !== order.handle && o.recipient === order.recipient && claims(o)))) fail("script already used");
  }
  private view(state: State, order: Order) {
    const self = this;
    return Effect.gen(function* () {
      const saved = yield* self.storage.acknowledged("sales_order", order.id);
      const acknowledged = saved?.value as unknown as Order | null | undefined;
      const cancelled = order.status === "cancelled";
      const final = cancelled && acknowledged?.status === "cancelled";
      const hold = active(state, order) ? order.grants.at(-1)! : null;
      const rejected = postIssuance(order) ? recipientBlock(state, order) !== null : state.orders.some(o => o.destination?.script === order.recipient ||
        (o.handle !== order.handle && claims(o) && o.recipient === order.recipient));
      const account = yield* self.storage.acknowledged("refund_account", order.id);
      const refund = account?.value as unknown as State["accounts"][number] | undefined;
      const funds = balance(state, order), monitoring = state.monitors.find(m => m.order === order.id);
      const certificate = yield* certificateBytes(self.registryContext, state, order.id);
      const status = order.status === "fulfilled" && acknowledged?.status !== "fulfilled" ? (acknowledged?.status ?? "issuing") :
        cancelled && !final ? (acknowledged?.status ?? "requested") : order.status;
      return { handle: order.handle, recipient_script_pubkey: order.recipient,
        status: status === "ready" && !certificate ? "issuing" : status,
        certificate_available: certificate !== null,
        recovery_incident: yield* recoveryView(self.registryContext, state, order.id),
        cancellation: cancelled ? (final ? "final" : "unconfirmed") : null,
        price_sats: order.price,
        address: rejected || order.paymentHistory === "unknown" ? null : acknowledged?.destination?.address ?? null,
        address_pending: !rejected && !!order.destination && !acknowledged?.destination,
        recipient_rejected: rejected,
        acknowledged: !!acknowledged?.destination,
        pay_first: order.payFirst,
        payment_warning: order.payFirst ? "This invoice does not reserve the name. Another buyer may pay first; if that happens, your payment is refunded less the refund fee." : null,
        quote_expires_at: order.quotedAt === null ? null : order.quotedAt + 900,
        hold_expires_at: hold?.until ?? null,
        detected_sats: total(state, order, 0), confirmed_sats: total(state, order, 1),
        batchable_sats: total(state, order, 3), settled_sats: total(state, order, 6),
        payment_history: order.paymentHistory,
        refund_address: refund?.destination?.address ?? null,
        buyer_refund_fee_ceiling_sats: refund?.ceiling ?? null,
        excess_minimum: "Estimated refund fee plus 546 sats; smaller excess is not refunded.",
        excess_assessment: claims(order) && unserved(state, order) > 0 ? state.assessments.filter(a => a.order === order.id).map(a => ({ status: a.status,
          assessed_at: a.at, principal_sats: a.principal, estimated_fee_sats: a.fee,
          minimum_sats: a.fee === null ? null : a.fee + 546 }))[0] ?? null : null,
        refundable_sats: available(state, order.id),
        refunded_sats: funds.refunded, reserved_refund_sats: funds.reserved, refund_exposure_sats: funds.exposure,
        refund_groups: yield* Effect.forEach(state.groups.filter(g => g.order === order.id), g => self.groupView(state, g)),
        refund_deadlines: (monitoring?.deadlines ?? []).map(d => ({ started_at: d.dueAt, target_at: d.dueAt + 86400,
          principal_sats: d.principal, remaining_sats: d.remaining, broadcast_at: d.completedAt, incident: d.incident })),
        reconciling: monitoring?.reasons ?? [] };
    });
  }
  request(body: unknown) {
    const self = this;
    return Effect.gen(function* () {
      // Malformed bodies are rejected before entering the queue or reading state.
      const input = yield* checked(() => request(body));
      return yield* self.queue.withPermit(Effect.gen(function* () {
        const { records, state } = yield* self.load();
        yield* checked(() => {
          if (!state.listings.some(n => n.handle === input.handle)) fail("not for sale");
          if (state.orders.some(o => o.destination?.script === input.script ||
              (o.handle !== input.handle && claims(o) && o.recipient === input.script))) fail("script already used");
        });
        const token = randomBytes(24).toString("base64url"), sequence = state.settings.nextOrder++;
        state.orders.push({ id: `o${sequence}`, sequence, handle: input.handle, space: input.handle.split("@")[1]!,
          recipient: input.script, tokenHash: hash(token), status: "requested", quotedAt: null,
          quotedPrice: null, price: null, destination: null, payFirst: false, grants: [],
          everConverted: false, paymentHistory: "none", lateEvaluated: false });
        state.accounts.push({ order: `o${sequence}`, destination: null, ceiling: null });
        yield* self.save(records, state);
        return { order_link: `/orders/${token}`, token };
      }));
    });
  }
  quote(token: string) {
    const self = this;
    return self.queue.withPermit(Effect.gen(function* () {
      // Authenticate before touching the chain or wallet.
      const initial = yield* self.load();
      yield* checked(() => self.find(initial.state, token));
      const { records, state } = yield* self.refresh();
      const order = yield* checked(() => self.find(state, token));
      yield* checked(() => self.recipient(state, order));
      if (order.status === "quoted" && order.destination) {
        yield* self.storage.flush();
        return yield* self.view(state, order);
      }
      yield* checked(() => {
        if (order.status !== "requested") fail("already quoted");
        return admission(state, order);
      });
      const flushed = yield* self.storage.flush();
      const position = yield* self.storage.status();
      if (!flushed || !(yield* self.storage.confirm(position.seq)))
        return yield* checked(() => fail("the off-host journal is unavailable; no quote was made", "unavailable"));
      const held = new Set(heldScripts(state));
      let chosen: Destination | undefined;
      for (let draw = 0; draw <= held.size; draw++) {
        const candidate = yield* self.adapters.newDestination;
        yield* verified(() => destination(candidate));
        if (!held.has(candidate.script)) { chosen = { ...candidate }; break; }
      }
      yield* checked(() => {
        if (!chosen) fail("the payment wallet gave out only addresses that orders hold; no quote was made");
        if (chosen.script === order.recipient) fail("recipient is a store destination script");
        // Wallet work can take time. Re-evaluate timers before granting the
        // invoice, while retaining the queue and the last real chain evidence.
        refresh(state, self.adapters.clock(), { tip: state.settings.tip,
          outputs: state.payments.filter(p => p.active) });
        const payFirst = admission(state, order);
        order.destination = chosen; order.payFirst = payFirst; order.status = "quoted";
        order.quotedAt = state.settings.lastTime;
        order.price = order.quotedPrice = state.listings.find(n => n.handle === order.handle)!.price;
        state.accounts.find(a => a.order === order.id)!.ceiling = state.refunds.policy.buyerFeeCeiling;
        if (!payFirst) grant(state, order);
      });
      yield* self.save(records, state);
      return yield* self.view(state, order);
    }));
  }
  order(token: string) {
    const self = this;
    return self.queue.withPermit(Effect.gen(function* () {
      const initial = yield* self.load();
      yield* checked(() => self.find(initial.state, token));
      const { state } = yield* self.refresh();
      yield* self.storage.flush();
      const order = yield* checked(() => self.find(state, token));
      return yield* self.view(state, order);
    }));
  }
  cancel(token: string) {
    const self = this;
    return self.queue.withPermit(Effect.gen(function* () {
      const initial = yield* self.load();
      yield* checked(() => self.find(initial.state, token));
      const { records, state } = yield* self.refresh();
      const order = yield* checked(() => self.find(state, token));
      yield* checked(() => {
        if (postIssuance(order)) fail("not cancellable once issuing");
        order.status = "cancelled"; release(order);
        advance(state, self.adapters.clock());
        reconcile(state);
      });
      yield* self.save(records, state);
      yield* self.storage.flush();
      return yield* self.view(state, order);
    }));
  }
  observe() { return this.queue.withPermit(this.refresh().pipe(Effect.asVoid)); }
  /** Advance known deadlines without pretending an unavailable node was observed. */
  tick() {
    const self = this;
    return self.queue.withPermit(Effect.gen(function* () {
      const { records, state } = yield* self.load();
      yield* verified(() => tick(state, self.adapters.clock()));
      yield* self.save(records, state); yield* self.storage.flush();
    }));
  }
  certificate(token: string) {
    const self = this;
    return self.queue.withPermit(Effect.gen(function* () {
      const initial = yield* self.load();
      yield* checked(() => self.find(initial.state, token));
      const { state } = yield* self.refresh();
      const order = yield* checked(() => self.find(state, token));
      return (yield* certificateBytes(self.registryContext, state, order.id)) ?? (yield* checked(() => fail("certificate unavailable", "not_found")));
    }));
  }
  /** Operator inspection advances existing clocks even when Core is unavailable.
   * It discovers no new obligations and never signs or sends. */
  operatorStatus() {
    const self = this;
    return self.queue.withPermit(Effect.gen(function* () {
      const { records, state } = yield* self.load();
      yield* verified(() => tick(state, self.adapters.clock()));
      yield* self.save(records, state); yield* self.storage.flush();
      const position = yield* self.storage.status();
      const chain = self.adapters.chainStatus ? yield* self.adapters.chainStatus.pipe(Effect.match({
        onSuccess: value => value, onFailure: () => null,
      })) : null;
      return { orders: structuredClone(state.monitors), alerts: structuredClone(state.alerts), assessments: structuredClone(state.assessments),
        recovery_incidents: structuredClone(state.incidents), acknowledged: position.acknowledged === position.seq,
        chain, paused: state.settings.paused, application_recovery: state.recovery };
    }));
  }
  private inspectedOrder(state: State, order: Order) {
    const self = this;
    return Effect.gen(function* () {
      const record = yield* self.storage.acknowledged("sales_order", order.id);
      const saved = record?.value as unknown as Order | undefined;
      return { oid: order.id, name: order.handle, recipient_spk: order.recipient, status: order.status,
        price: order.price, price_reserve: claims(order) ? order.price : 0,
        dest_address: saved?.destination?.address ?? null, journaled_status: saved?.status ?? null,
        confirmed_sum: total(state, order, 1), batchable_sum: total(state, order, 3), settled_sum: total(state, order, 6),
        refunded_total: balance(state, order).refunded, reserved: balance(state, order).reserved,
        reasons: [...(state.monitors.find(m => m.order === order.id)?.reasons ?? [])],
        fulfillment: structuredClone(state.fulfillments.find(f => f.oid === order.id) ?? null),
        incident: structuredClone(state.incidents.filter(i => i.oid === order.id).at(-1) ?? null) };
    });
  }
  inspectionOrders(status?: string) {
    const self = this;
    return self.queue.withPermit(Effect.gen(function* () {
      yield* checked(() => {
        if (status !== undefined && !["requested", "quoted", "unpaid", "converted", "issuing", "ready", "fulfilled", "cancelled", "refund_due"].includes(status))
          fail("invalid order status", "invalid");
      });
      const { state } = yield* self.load();
      return { orders: yield* Effect.forEach(state.orders.filter(o => status === undefined || o.status === status), o => self.inspectedOrder(state, o)) };
    }));
  }
  inspectionOrder(id: string) {
    const self = this;
    return self.queue.withPermit(Effect.gen(function* () {
      const { state } = yield* self.load();
      const order = yield* checked(() => state.orders.find(o => o.id === id) ?? fail("no such order", "not_found"));
      return yield* self.inspectedOrder(state, order);
    }));
  }
  recordMerchantLoss(id: string, reason: Reason) {
    const self = this;
    return self.queue.withPermit(Effect.gen(function* () {
      const { records, state } = yield* self.refresh();
      yield* checked(() => recordLoss(state, id, reason));
      yield* self.save(records, state); yield* self.storage.flush();
    }));
  }
  private refundAdapters(): RefundAdapters {
    return this.adapters.refunds ?? fail("refund wallet is not configured", "unavailable");
  }
  private groupView(state: State, g: RefundGroup) {
    const self = this;
    return Effect.gen(function* () {
      const chosen = winner(state, g) ?? preferred(state, g);
      const saved = yield* self.storage.acknowledged(chosen.ordinal ? "refund_attempt" : "refund_group", chosen.id);
      const intent = state.refundSends.find(s => s.txid === chosen.transaction?.txid);
      const savedIntent = intent ? yield* self.storage.acknowledged("refund_send", evidenceKey(state, intent)) : null;
      const target = chosen.ordinal ? state.refundAttempts.find(a => a.id === chosen.id)! : g;
      // No raw transaction or intermediate signed draft leaves this API.
      return { ...summary({ ...g, charged: reservation(state, g), transaction: chosen.transaction }, !!saved && JSON.stringify(saved.value) === JSON.stringify(target)),
        refund_address: chosen.transaction?.outputs.find(o => o.role === "buyer")?.address ?? state.accounts.find(a => a.order === g.order)!.destination?.address ?? null,
        ...refundStatus(state, g, chosen.transaction?.txid), original_txid: g.transaction?.txid ?? null,
        settled_txid: winner(state, g)?.transaction?.txid ?? null,
        maximum_charge_sats: reservation(state, g), settled_charge_sats: winner(state, g)?.charged ?? null,
        selected_charge_sats: chosen.charged,
        pending_attempt: state.refundAttempts.find(a => a.group === g.id && a.phase === "reserved")?.id ?? null,
        rebuild_paused: state.refundPauses.some(p => p.group === g.id && p.active),
        operator_notices: state.refundPauses.filter(p => p.group === g.id).map(p => ({ code: "refund_rebuild_paused", active: p.active, first_at: p.firstAt, last_at: p.lastAt })),
        attempts: members(state, g).map(m => ({ id: m.id, ordinal: m.ordinal, phase: m.phase, charged_sats: m.charged,
          txid: m.transaction?.txid ?? null, to_buyer_sats: m.transaction?.toBuyer ?? null, fee_sats: m.transaction?.fee ?? null,
          seen: state.refundObservations.find(o => o.txid === m.transaction?.txid)?.seen ?? "unobserved",
          confirmations: state.refundObservations.find(o => o.txid === m.transaction?.txid)?.confirmations ?? 0,
          broadcast_intents: state.refundSends.find(s => s.txid === m.transaction?.txid)?.calls ?? 0 })),
        intent_acknowledged: intent ? !!savedIntent && JSON.stringify(savedIntent.value) === JSON.stringify(intent) : null };
    });
  }
  setRefundDestination(token: string, address: string) {
    const self = this;
    return self.queue.withPermit(Effect.gen(function* () {
      const initial = yield* self.load(); yield* checked(() => self.find(initial.state, token));
      const { records, state, tipHash } = yield* self.refresh(), order = yield* checked(() => self.find(state, token));
      const adapters = yield* checked(() => self.refundAdapters());
      yield* checked(() => {
        if (typeof address !== "string" || !address || address.length > 256) fail("invalid refund address", "invalid");
        if (state.groups.some(g => g.order === order.id && g.phase === "built")) fail("a refund has been built; its destination is fixed");
      });
      const resolved = yield* adapters.resolveAddress(address);
      yield* checked(() => {
        destination(resolved);
        if (state.orders.some(o => o.destination?.script === resolved.script) ||
            state.refunds.merchantDestinations.some(d => d.script === resolved.script) ||
            allMembers(state).some(m => m.transaction?.outputs.some(o => o.role !== "buyer" && o.script === resolved.script)))
          fail("a refund never goes to a store payment or funding address");
        state.accounts.find(a => a.order === order.id)!.destination = { ...resolved };
        advance(state, self.adapters.clock());
        reconcile(state);
      });
      const eligible = yield* assess(state, adapters, tipHash, self.adapters.clock);
      yield* verified(() => reconcile(state, eligible));
      yield* self.save(records, state); yield* self.storage.flush(); return yield* self.view(state, order);
    }));
  }
  /** Lower-level explicit reservation. HTTP retries use prepareOperatorRefund. */
  prepareRefund(id: string, kind: RefundGroup["kind"], cause: RefundGroup["cause"]) {
    const self = this;
    return self.queue.withPermit(Effect.gen(function* () {
      const adapters = yield* checked(() => self.refundAdapters());
      const { records, state } = yield* self.refresh();
      const estimate = yield* adapters.estimateRate(state.refunds.policy.confirmationTarget);
      const g = yield* checked(() => reserve(state, id, kind, cause, estimate));
      yield* self.save(records, state);
      return yield* self.build(g.id);
    }));
  }
  private build(id: string) {
    const self = this;
    return Effect.gen(function* () {
      const { records, state } = yield* self.refresh();
      const g = yield* checked(() => state.groups.find(g => g.id === id) ?? fail("no such refund", "not_found"));
      if (g.phase !== "reserved") { yield* self.storage.flush(); return yield* self.groupView(state, g); }
      const flushed = yield* self.storage.flush(), position = yield* self.storage.status();
      if (!flushed || !(yield* self.storage.confirm(position.seq))) return yield* self.groupView(state, g);
      const request = yield* checked(() => buildRequest(state, g));
      const adapters = yield* checked(() => self.refundAdapters());
      const transaction = yield* adapters.build(request);
      yield* verified(() => recordBuilt(g, request, transaction));
      yield* self.save(records, state); return yield* self.groupView(state, g);
    });
  }
  buildRefund(id: string) { return this.queue.withPermit(this.build(id)); }
  /** Retry the outstanding preparation before allocating any new credit. */
  prepareOperatorRefund(id: string, kind: RefundGroup["kind"], cause: RefundGroup["cause"]) {
    const self = this;
    return self.queue.withPermit(Effect.gen(function* () {
      const { records, state } = yield* self.refresh();
      yield* checked(() => { if (!["excess", "cancellation"].includes(kind) || !["buyer", "merchant"].includes(cause)) fail("invalid refund request", "invalid"); });
      const active = state.groups.filter(g => g.order === id && g.phase !== "void" && !settled(state, g));
      if (active.length) {
        const g = yield* checked(() => {
          if (active.length !== 1 || active[0]!.kind !== kind || active[0]!.cause !== cause)
            fail("another refund is outstanding; inspect and finish it first");
          return active[0]!;
        });
        return yield* self.build(g.id);
      }
      const adapters = yield* checked(() => self.refundAdapters());
      const estimate = yield* adapters.estimateRate(state.refunds.policy.confirmationTarget);
      const g = yield* checked(() => reserve(state, id, kind, cause, estimate));
      yield* self.save(records, state); return yield* self.build(g.id);
    }));
  }
  inspectionRefund(id: string) {
    const self = this;
    return self.queue.withPermit(Effect.gen(function* () {
      const { state } = yield* self.refresh(); yield* self.storage.flush();
      const g = yield* checked(() => state.groups.find(g => g.id === id) ?? fail("no such refund", "not_found"));
      return yield* self.groupView(state, g);
    }));
  }
  broadcastOperatorRefund(id: string, txid: string) {
    return this.queue.withPermit(this.sendRefund(id, txid, true));
  }
  bumpRefund(id: string, feeRate: number, charged?: number, absorbFeeIncrease = false) {
    const self = this;
    return self.queue.withPermit(Effect.gen(function* () {
      yield* checked(() => { if (!self.refundAdapters().sender) fail("refund sender is required", "unavailable"); });
      const { records, state } = yield* self.refresh();
      const a = yield* checked(() => reserveAttempt(state, id, feeRate, charged, absorbFeeIncrease));
      yield* self.save(records, state); return yield* self.buildAttempt(a.id);
    }));
  }
  rebuildRefund(id: string, feeRate: number, charged?: number) {
    const self = this;
    return self.queue.withPermit(Effect.gen(function* () {
      const plan = yield* checked(() => self.refundAdapters().rebuildFunding ?? fail("rebuild funding adapter is required", "unavailable"));
      const { records, state } = yield* self.refresh();
      const request = yield* checked(() => rebuildRequest(state, id));
      const result = yield* plan(request).pipe(Effect.match({ onSuccess: funding => ({ ok: true as const, funding }), onFailure: error => ({ ok: false as const, error }) }));
      if (!result.ok) {
        if (result.error.code === "refused") {
          const previous = state.refundPauses.find(p => p.group === id);
          if (previous) { previous.active = true; previous.lastAt = state.settings.lastTime; }
          else state.refundPauses.push({ group: id, firstAt: state.settings.lastTime, lastAt: state.settings.lastTime, active: true });
          yield* self.save(records, state);
        }
        return yield* Effect.fail(result.error);
      }
      const a = yield* checked(() => reserveAttempt(state, id, feeRate, charged, false, result.funding));
      const paused = state.refundPauses.find(p => p.group === id); if (paused) paused.active = false;
      yield* self.save(records, state); return yield* self.buildAttempt(a.id);
    }));
  }
  private buildAttempt(id: string) {
    const self = this;
    return Effect.gen(function* () {
      const { records, state } = yield* self.refresh();
      const a = yield* checked(() => state.refundAttempts.find(a => a.id === id) ?? fail("no such refund attempt", "not_found"));
      const g = state.groups.find(g => g.id === a.group)!;
      if (a.phase !== "reserved") { yield* self.storage.flush(); return yield* self.groupView(state, g); }
      const flushed = yield* self.storage.flush(), position = yield* self.storage.status();
      if (!flushed || !(yield* self.storage.confirm(position.seq))) return yield* self.groupView(state, g);
      const request = yield* checked(() => attemptRequest(state, a));
      const adapters = yield* checked(() => self.refundAdapters());
      const transaction = yield* adapters.build(request);
      yield* verified(() => finishAttempt(state, a, request, transaction));
      yield* self.save(records, state); return yield* self.groupView(state, g);
    });
  }
  buildRefundAttempt(id: string) { return this.queue.withPermit(this.buildAttempt(id)); }
  discardUnbuiltAttempt(id: string) {
    const self = this;
    return self.queue.withPermit(Effect.gen(function* () {
      const { records, state } = yield* self.load();
      const a = yield* checked(() => state.refundAttempts.find(a => a.id === id) ?? fail("no such refund attempt", "not_found"));
      yield* checked(() => { if (a.phase !== "reserved") fail("only an unbuilt attempt can be discarded"); });
      a.phase = "void"; yield* self.save(records, state); return yield* self.groupView(state, state.groups.find(g => g.id === a.group)!);
    }));
  }
  discardUnbuiltRefund(id: string) {
    const self = this;
    return self.queue.withPermit(Effect.gen(function* () {
      const { records, state } = yield* self.load();
      const g = yield* checked(() => state.groups.find(g => g.id === id) ?? fail("no such refund", "not_found"));
      yield* checked(() => { if (g.phase !== "reserved") fail("only an unbuilt reservation can be discarded"); });
      g.phase = "void"; yield* self.save(records, state); return yield* self.groupView(state, g);
    }));
  }
  private sendRefund(id: string, requestedTxid?: string, exact = false) {
    const self = this;
    return Effect.gen(function* () {
      const sender = yield* checked(() => self.refundAdapters().sender ?? fail("refund sender is not configured", "unavailable"));
      const { records, state } = yield* self.refresh();
      const g = yield* checked(() => state.groups.find(g => g.id === id) ?? fail("no such refund", "not_found"));
      yield* checked(() => {
        if (exact && (winner(state, g) ?? preferred(state, g)).transaction?.txid !== requestedTxid)
          fail("refund transaction changed; inspect and confirm again");
      });
      if (settled(state, g)) return yield* self.groupView(state, g);
      const member = yield* checked(() => requestedTxid ? members(state, g).find(m => m.transaction?.txid === requestedTxid) ?? fail("transaction is not in this refund") : preferred(state, g));
      const tx = yield* checked(() => member.transaction ?? fail("refund has not been built"));
      const facts = state.refundObservations.find(o => o.txid === tx.txid);
      if (facts?.seen === "mempool" || facts?.seen === "mined") return yield* self.groupView(state, g);
      const previous = state.refundSends.find(s => s.txid === tx.txid);
      yield* checked(() => {
        if (!sendable(state, g, tx.txid)) fail("refund funding is unavailable or needs rebuild");
        if (!previous && balance(state, state.orders.find(o => o.id === g.order)!).exposure > 0) fail("refund credit is no longer settled");
      });
      const intent = { group: id, txid: tx.txid, firstIntentAt: previous?.firstIntentAt ?? state.settings.lastTime,
        lastIntentAt: state.settings.lastTime, calls: (previous?.calls ?? 0) + 1, result: "uncertain" as const };
      if (previous) Object.assign(previous, intent); else state.refundSends.push(intent);
      yield* self.save(records, state);
      yield* self.storage.flush();
      const position = yield* self.storage.status();
      if (!(yield* self.storage.confirm(position.seq))) return yield* self.groupView(state, g);
      const permission = self.storage.confirm(position.seq).pipe(Effect.mapError(() => new ApplicationError({ code: "unavailable", message: "refund journal check failed" })));
      const accepted = yield* sender.broadcast(tx, permission, { tip: facts!.tip, tipHash: facts!.tipHash }, member.replacement)
        .pipe(Effect.match({ onSuccess: () => true, onFailure: () => false }));
      // Interruption anywhere above leaves the durable intent uncertain.
      if (accepted) {
        const current = yield* self.load();
        current.state.refundSends.find(s => s.txid === tx.txid)!.result = "accepted";
        yield* verified(() => {
          advance(current.state, self.adapters.clock()); noteBroadcast(current.state, id, tx.txid); reconcile(current.state);
        });
        yield* self.save(current.records, current.state);
      }
      const current = yield* self.refresh();
      return yield* self.groupView(current.state, current.state.groups.find(g => g.id === id)!);
    });
  }
  broadcastRefund(id: string, txid?: string) { return this.queue.withPermit(this.sendRefund(id, txid)); }
  /** Only previously attempted, absent transactions may be retried. Reads do not send. */
  reconcileRefunds() {
    const self = this;
    return self.queue.withPermit(Effect.gen(function* () {
      const { state } = yield* self.refresh();
      const candidates = state.groups.flatMap(g => {
        if (settled(state, g)) return [];
        const candidate = members(state, g).filter(m => state.refundSends.some(s => s.txid === m.transaction?.txid)).at(-1);
        return candidate?.transaction && sendable(state, g, candidate.transaction.txid) ? [candidate] : [];
      });
      return yield* Effect.forEach(candidates, m => self.sendRefund(m.group, m.transaction!.txid));
    }));
  }
  /** Single-member convenience; batch callers use the atomic registry method. */
  beginIssuance(id: string) {
    return this.registry.markIssuing([id]).pipe(Effect.asVoid);
  }
  listName(handle: string, price: number) {
    const self = this;
    return self.queue.withPermit(Effect.gen(function* () {
      yield* checked(() => { if (!canonicalHandle(handle)) fail("invalid handle", "invalid"); sats(price); });
      const { records, state } = yield* self.load();
      const listing = state.listings.find(n => n.handle === handle);
      if (listing) listing.price = price;
      else state.listings.push({ handle, space: handle.split("@")[1]!, price });
      yield* self.save(records, state);
      yield* self.storage.flush();
      const saved = yield* self.storage.acknowledged("listing", handle);
      return { handle, price_sats: price, acknowledged: !!saved && (saved.value as { price: number }).price === price };
    }));
  }
  pause(paused: boolean) {
    const self = this;
    return self.queue.withPermit(Effect.gen(function* () {
      const { records, state } = yield* self.load();
      state.settings.paused = paused;
      yield* self.save(records, state);
      yield* self.storage.flush();
      const saved = yield* self.storage.acknowledged("sales_settings", "global");
      return { paused, acknowledged: !!saved && (saved.value as { paused: boolean }).paused === paused };
    }));
  }
}
