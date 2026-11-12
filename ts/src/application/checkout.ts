import type { IncomingMessage, ServerResponse } from "node:http";
import { Effect } from "effect";
import { canonicalHandle } from "../recipient.ts";
import { ApplicationError, checked, fail, request as recipientRequest } from "./records.ts";
import { body, parseRequest } from "./http.ts";
import type { SalesStore } from "./store.ts";

type OrderView = Effect.Success<ReturnType<SalesStore["order"]>>;
type Catalog = Effect.Success<ReturnType<SalesStore["catalog"]>>;
export interface CheckoutResponse { code: number; data: string | Buffer; location?: string }
export const checkoutHeaders = {
  "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
};
export function sendCheckout(response: ServerResponse, answer: CheckoutResponse) {
  if (response.destroyed) return;
  const binary = Buffer.isBuffer(answer.data);
  response.writeHead(answer.code, { ...checkoutHeaders, "Content-Type": binary ? "application/octet-stream" : "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(answer.data),
    ...(binary ? { "Content-Disposition": 'attachment; filename="certificate.message"' } : {}),
    ...(answer.location ? { Location: answer.location } : {}) });
  response.end(answer.data);
}
export const esc = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
export function btc(sats: number) {
  const value = BigInt(sats), whole = value / 100_000_000n, fraction = (value % 100_000_000n).toString().padStart(8, "0").replace(/0+$/, "");
  return `${whole}${fraction ? "." + fraction : ""}`;
}
const amount = (sats: number) => sats.toLocaleString("en-US");
const time = (seconds: number) => esc(new Date(seconds * 1000).toISOString().replace("T", " ").replace(".000Z", " UTC"));
const style = `
:root{color-scheme:light;--ink:#183128;--muted:#52675d;--line:#cfdbd1;--paper:#fffef9;--green:#215842}
*{box-sizing:border-box}body{margin:0;background:#f2f4ed;color:var(--ink);font:16px/1.6 system-ui,sans-serif}
header,main,footer{max-width:760px;margin:auto;padding:24px}header{display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--line)}
header a{font-weight:650;text-decoration:none}header span,.muted,small{color:var(--muted)}main{padding-top:44px;padding-bottom:56px}h1{font-size:clamp(28px,5vw,42px);line-height:1.15;letter-spacing:-.035em;overflow-wrap:anywhere;margin:10px 0 22px}
h2{font-size:20px;line-height:1.3;margin:30px 0 14px}p{margin:12px 0}a{color:var(--green);text-underline-offset:3px}code{font:14px/1.7 ui-monospace,monospace;overflow-wrap:anywhere}
.eyebrow{font-size:12px;text-transform:uppercase;letter-spacing:.12em;color:var(--muted)}.panel{background:var(--paper);border:1px solid var(--line);border-radius:16px;padding:24px;margin:22px 0}.notice{border-left:4px solid #a57927;background:#fff7dd;padding:14px 18px;border-radius:4px;margin:20px 0}
.status{display:inline-block;background:#dfeade;border-radius:20px;padding:4px 14px;font-size:14px;font-weight:600}.price{font-size:25px;font-weight:600}.payment-address{display:block;padding:14px;background:#edf2e9;border-radius:8px}
label{font-weight:600;display:block;margin:14px 0 8px}textarea,input{font:15px/1.5 ui-monospace,monospace;width:100%;border:1px solid #8fa397;background:white;color:var(--ink);border-radius:8px;padding:12px}textarea{min-height:180px;resize:vertical}button,.button{display:inline-block;background:var(--green);color:white;border:0;border-radius:8px;font:600 15px/1.5 system-ui,sans-serif;padding:12px 20px;cursor:pointer;text-decoration:none;margin:12px 0}button.secondary{background:#e4e9df;color:var(--ink)}button:focus-visible,a:focus-visible,input:focus-visible,textarea:focus-visible{outline:3px solid #c18b22;outline-offset:3px}
table{width:100%;border-collapse:collapse}th{text-align:left;font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}td,th{padding:16px 8px;border-bottom:1px solid var(--line)}td:first-child,th:first-child{padding-left:0}td:last-child{font-size:14px}td a{font-weight:600}dl{display:grid;grid-template-columns:1fr 1fr;gap:6px 16px}dt{color:var(--muted)}dd{margin:0;text-align:right;overflow-wrap:anywhere}.progress{padding-left:24px}.progress li{padding:5px 0;color:#6b7c71}.progress .done{color:var(--green);font-weight:600}footer{font-size:13px;border-top:1px solid var(--line)}@media(max-width:520px){header,main,footer{padding-left:18px;padding-right:18px}.panel{padding:18px}header span{font-size:12px}td,th{padding:12px 5px}dl{grid-template-columns:1fr}dd{text-align:left;margin-bottom:8px}}
`;
function page(code: number, title: string, content: string): CheckoutResponse {
  return { code, data: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · Subspace store</title><style>${style}</style></head><body><header><a href="/">Subspace store</a><span>Bitcoin · Your name, your keys</span></header><main>${content}</main><footer>No account needed. Keep your private order link to return to your purchase.</footer></body></html>` };
}
const notFound = () => page(404, "Not found", '<h1>Not found</h1><p>This page is unavailable.</p><p><a href="/">Browse names</a></p>');
function refused(error: unknown): CheckoutResponse {
  if (error instanceof ApplicationError && error.code === "not_found") return notFound();
  const code = error instanceof ApplicationError ? ({ invalid: 400, refused: 409, unavailable: 503, not_found: 404, throttled: 429 })[error.code] : 503;
  // Fixed refusal copy: never reflect a pasted request, secret member, token,
  // wallet/RPC error or other untrusted exception into a page.
  return page(code, code === 503 ? "Store temporarily unavailable" : "Request refused", code === 503 ?
    '<h1>We cannot confirm this order right now</h1><p>Try this page again in a moment. If you sent a payment, do not send another because of this message. It may still confirm.</p>' :
    '<h1>Request refused</h1><p>The action could not be accepted. Check the form and submit only the public data it asks for. Recipient requests must be copied exactly for the chosen name. Never paste a seed phrase, private key or wallet backup.</p><p><a href="/">Browse names</a></p>');
}
const redirect = (token: string): CheckoutResponse => ({ code: 303, data: "", location: `/o/${token}` });
const pausedNote = (paused: boolean) => paused ? '<p class="notice" id="paused">New invoices are paused. Existing invoices continue under their original payment and refund rules.</p>' : "";
function namesPage(catalog: Catalog) {
  return page(200, "Find your name", `<p class="eyebrow">Names, held by you</p><h1>A name of your own.</h1><p>Choose a name, bring a public request from your client, and pay in bitcoin. Your client keeps the keys.</p>${pausedNote(catalog.paused)}<div class="panel">${catalog.listings.length ? `<table><thead><tr><th>Name</th><th>Fixed price</th><th>Availability</th></tr></thead><tbody>${catalog.listings.map(n => `<tr data-handle="${esc(n.handle)}" data-available="${n.available}"><td>${n.available ? `<a href="/buy/${esc(n.handle)}">${esc(n.handle)}</a>` : esc(n.handle)}</td><td>${amount(n.price_sats)} sats</td><td>${n.available ? "Available" : "Taken for now"}</td></tr>`).join("")}</tbody></table>` : '<p>No names are listed right now.</p>'}</div><p class="muted">Use a client such as Nacho to create a public recipient request for your chosen name. No account or email address is required.</p>`);
}
function buyPage(catalog: Catalog, handle: string) {
  const listing = catalog.listings.find(n => n.handle === handle);
  if (!listing) return notFound();
  return page(200, handle, `<p class="eyebrow">01 / Your recipient request</p><h1>${esc(handle)}</h1><p class="price">${amount(listing.price_sats)} sats <small>fixed price</small></p>${pausedNote(catalog.paused)}${listing.available ? "" : '<p class="notice">This name is taken for now. A request does not reserve it or guarantee an invoice.</p>'}<form class="panel" method="post" action="/buy/${esc(handle)}"><label for="request">Paste your public recipient request</label><p id="request-help">Create a request for <strong>${esc(handle)}</strong> in your client, such as Nacho, then paste the complete JSON export. It contains the name and public recipient script.</p><textarea id="request" name="request" required spellcheck="false" autocapitalize="off" autocomplete="off" aria-describedby="request-help request-safety"></textarea><p id="request-safety" class="muted">Only a public request. Never paste a seed phrase, private key or wallet backup.</p><button type="submit">Continue to private order</button></form><p class="muted">Save the link on the next page. It is the only way to return to your order; anyone with it can view and manage the order.</p>`);
}
const progress = ["Request received", "Invoice issued", "Payment confirmed · 3 blocks", "Being issued on chain", "Certificate verified and ready", "Published and delivered"];
function paymentNote(v: OrderView): string {
  if (v.cancellation === "unconfirmed") return "Your cancellation is being recorded and is not final yet. Don't pay this invoice.";
  if (["converted", "issuing", "ready", "fulfilled"].includes(v.status)) return "Paid in full. Don't pay again.";
  if (v.status === "cancelled") return "This order is cancelled. Don't pay this invoice. Anything refundable follows the refund rules below.";
  if (v.status === "refund_due") return "A refund is due. Don't pay this invoice.";
  if (v.payment_history === "unknown") return "The store restored this order after an outage and cannot tell whether a payment was sent before then. Don't pay this invoice. A payment may still confirm, including after the invoice expires, when it is handled as a late payment. If you never paid, start a new order once this one ends.";
  if (v.detected_sats > 0) return v.detected_sats < v.price_sats! ?
    `Partial payment detected, awaiting confirmation: ${amount(v.detected_sats)} of ${amount(v.price_sats!)} sats. This page does not ask for the rest. Don't pay again because of this page. If an ordinary hold ends short, confirmed funds become refund due; a pay-first payment reserves no name until paid in full.` :
    "Payment detected, awaiting confirmation. Don't pay again.";
  if (v.payment_history === "detected") return "A payment was detected earlier and the store's node no longer sees it. It may have been dropped or replaced, or the node may have missed it; it can still confirm. Don't send another payment because of this page. If it confirms after the hold ends, it is handled as a late payment.";
  return "This invoice has expired or no longer buys the name. Don't pay it. Start a new order to buy the name.";
}
function invoice(v: OrderView) {
  if (v.price_sats === null || v.address_pending) return "";
  // The store has already evaluated expiry and chain evidence. A public pilot
  // pay-first invoice has no hold; its payable window is its quote window.
  const payable = v.status === "quoted" && v.cancellation === null && v.address !== null && v.payment_history === "none" &&
    v.detected_sats === 0 && v.quote_expires_at !== null && v.payment_request_open;
  const warning = v.pay_first ? `<p class="notice" id="pay_first_warning">${esc(v.payment_warning)}</p>` : "";
  const policy = `<p class="muted">Buyer cancellation, excess and a disclosed pay-first race loss are refunded less the network fee, up to ${v.buyer_refund_fee_ceiling_sats === null ? "the ceiling disclosed with the recorded invoice" : `${amount(v.buyer_refund_fee_ceiling_sats)} sats`}. Store-caused refunds return the full refundable principal. ${esc(v.excess_minimum)}</p>`;
  const destination = v.address ? `<code class="payment-address" id="${payable ? "address" : "invoice_address"}">${esc(v.address)}</code>` : '<p>The historical payment address is withheld while payment history is uncertain.</p>';
  const uri = `bitcoin:${encodeURIComponent(v.address ?? "")}?amount=${btc(v.price_sats)}`;
  return `<h2>${payable ? "Pay your invoice" : "Invoice history"}</h2>${warning}${policy}<div class="panel" id="${payable ? "payment_request" : "invoice_history"}">${payable ? `<p>Pay once: <strong id="amount_btc">${btc(v.price_sats)}</strong> BTC (<span id="price_sats">${v.price_sats}</span> sats).</p>${destination}<p><a class="button" id="bip21" href="${esc(uri)}">Open in Bitcoin wallet</a></p><p><code>${esc(uri)}</code></p><p class="muted">${v.pay_first ? "No name is reserved. Quote window ends" : "Held for you until"} ${time(v.pay_first ? v.quote_expires_at! : v.hold_expires_at!)}. Only send once; a sent payment appears when the store's node sees it.</p>` : `<p id="invoice_note">${esc(paymentNote(v))}</p><p>Original invoice: <span id="invoice_price_sats">${v.quoted_price_sats}</span> sats.</p>${destination}`}</div><dl><dt>Detected by the node</dt><dd><span id="detected_sats">${v.detected_sats}</span> sats</dd><dt>Awaiting first confirmation</dt><dd>${v.detected_sats - v.confirmed_sats} sats</dd><dt>Confirmed</dt><dd><span id="confirmed_sats">${v.confirmed_sats}</span> sats</dd><dt>At 3 blocks</dt><dd>${v.batchable_sats} sats</dd><dt>At 6 blocks</dt><dd>${v.settled_sats} sats</dd></dl><p class="muted">Mempool detection does not count as confirmation. Full payment needs 3 blocks before issuance; refundable funds need 6 blocks.</p>`;
}
function orderPage(v: OrderView, token: string, code = 200, note = "") {
  const base = `/o/${token}`, reached = ({ requested: 0, quoted: 1, converted: 2, issuing: 3, ready: 4, fulfilled: 5, cancelled: -1, unpaid: -1, refund_due: -1 })[v.status];
  const groups = v.refund_groups.map(g => `<div class="panel"><p>Refund status: <strong>${esc(g.status)}</strong></p>${g.attempts.map(a => `<p>Attempt ${a.ordinal + 1}: ${a.to_buyer_sats === null ? "being prepared" : `${amount(a.to_buyer_sats)} sats to you; ${amount(a.fee_sats!)} sats network fee`}. ${esc(a.seen)}, ${a.confirmations} confirmations.${a.txid ? ` <code>${esc(a.txid)}</code>` : ""}</p>`).join("")}</div>`).join("");
  return page(code, `Order for ${v.handle}`, `<p class="eyebrow">Your private order</p><h1>${esc(v.handle)}</h1><p><span class="status" id="status">${esc(v.status)}</span>${v.cancellation ? ` Cancellation: <span id="cancellation">${esc(v.cancellation)}</span>` : ""}</p>${note ? `<p class="notice" id="note">${esc(note)}</p>` : ""}<p class="notice">Save this private link. Anyone with it can view this order, set its refund address and cancel before issuance. The store cannot recover a lost order link.</p><p><a href="${base}">Refresh order status</a></p>${v.recipient_rejected ? '<p class="notice">The store cannot issue to this recipient script. Contact the operator; no payment request is shown.</p>' : `<ol class="progress">${progress.map((s, i) => `<li${i <= reached ? ' class="done"' : ""}>${esc(s)}</li>`).join("")}</ol>`}<details><summary>Your public recipient script</summary><code id="recipient_script">${esc(v.recipient_script_pubkey)}</code></details>${v.status === "requested" && !v.recipient_rejected ? `<form method="post" action="${base}/invoice"><button type="submit">Get the invoice</button></form><p class="muted">An ordinary invoice holds the name for 15 minutes. If hold limits require pay-first, the invoice will explain the race before showing an address.</p>` : ""}${v.address_pending ? `<p class="notice" id="address_pending">Your invoice is being recorded. No address is shown until the off-host journal acknowledges it. Try again.</p><form method="post" action="${base}/invoice"><button type="submit">Try recording the invoice again</button></form>` : ""}${invoice(v)}${v.certificate_available ? `<h2>Your certificate</h2><p><a class="button" id="certificate" href="${base}/certificate">Download certificate</a></p><p>Import and verify the certificate in your client before relying on the name.</p>` : ""}<h2>What happens next</h2><p class="muted">Issuance and delivery are attended by the operator. Confirmation, on-chain issuance, finality, anchor coverage and relay verification can delay progress. Refresh this page for updates.</p>${v.reconciling.length ? '<p class="notice">The operator is reconciling this order. Keep your link and do not pay again.</p>' : ""}${v.recovery_incident?.open ? '<p class="notice">This order has a recovery incident. Contact the operator and keep your certificate and order link.</p>' : ""}<h2>Refund address</h2><p>Use a Bitcoin address you control on the same network as your payment. A refund never goes to a store payment address.</p>${v.refund_address ? `<p>Recorded destination: <code id="refund_address">${esc(v.refund_address)}</code></p>` : '<p>No refund address is recorded yet.</p>'}${!v.refund_groups.some(g => g.phase === "built") ? `<form method="post" action="${base}/refund-address"><label for="refund-address">Your refund address</label><input id="refund-address" name="address" required maxlength="256" spellcheck="false" autocapitalize="off" autocomplete="off"><button class="secondary" type="submit">Record refund address</button></form>` : '<p class="muted">A refund has been built; its destination is fixed.</p>'}<p class="muted">Eligible refunds target broadcast within 24 hours once funds have 6 confirmations and a valid destination is recorded. Confirmation takes its own time.</p><dl><dt>Refunded principal</dt><dd>${amount(v.refunded_sats)} sats</dd><dt>Reserved for refunds</dt><dd>${amount(v.reserved_refund_sats)} sats</dd></dl>${groups}${v.refund_deadlines.map(d => `<p>Refund target: ${time(d.target_at)}.${d.incident ? " The broadcast target was missed; the operator has an incident to resolve." : ""}</p>`).join("")}${!["issuing", "ready", "fulfilled", "cancelled", "refund_due"].includes(v.status) && !v.cancellation ? `<h2>Cancel this order</h2><p>Cancellation is available before issuance. A partial refund closes this checkout; a later purchase uses a new order. A buyer-caused refund pays the network fee up to the disclosed ceiling.</p><form method="post" action="${base}/cancel"><button class="secondary" type="submit">Cancel order and request refund of eligible funds</button></form>` : ""}`);
}
function form(request: IncomingMessage, field?: string) {
  return Effect.tryPromise({ try: async () => {
    const raw = await body(request);
    if (!field && raw === "") return "";
    if (!field || !/^application\/x-www-form-urlencoded(?:\s*;\s*charset=utf-8)?$/i.test(request.headers["content-type"] ?? "") || /%(?![0-9a-f]{2})/i.test(raw))
      fail("invalid checkout form", "invalid");
    // decodeURIComponent is fatal for malformed percent-encoded UTF-8.
    const pairs = raw.split("&").map(pair => pair.split("="));
    if (pairs.length !== 1 || pairs[0]!.length !== 2 || decodeURIComponent(pairs[0]![0]!.replace(/\+/g, " ")) !== field) fail("invalid checkout form", "invalid");
    return decodeURIComponent(pairs[0]![1]!.replace(/\+/g, " "));
  }, catch: () => new ApplicationError({ code: "invalid", message: "invalid checkout form" }) });
}
/** The browser transport shares every domain command with the JSON API. */
export function checkoutRoute(store: SalesStore, incoming: IncomingMessage): Effect.Effect<CheckoutResponse> | undefined {
  const path = incoming.url ?? "", method = incoming.method;
  if (!(path === "/" || path.startsWith("/buy/") || path.startsWith("/o/"))) return undefined;
  return Effect.gen(function* () {
    if (path === "/" && method === "GET") return namesPage(yield* store.catalog());
    const buy = /^\/buy\/([^/?#]+)$/.exec(path);
    if (buy && canonicalHandle(buy[1])) {
      const handle = buy[1];
      if (method === "GET") return buyPage(yield* store.catalog(), handle);
      if (method === "POST") {
        const raw = yield* form(incoming, "request");
        const input = yield* checked(() => {
          const value = parseRequest(raw), input = recipientRequest(value);
          if (input.handle !== handle) fail("recipient request names another handle", "invalid");
          return value;
        });
        return redirect((yield* store.request(input)).token);
      }
    }
    const order = /^\/o\/([A-Za-z0-9_-]{32})(\/(?:invoice|cancel|refund-address|certificate))?$/.exec(path);
    if (order) {
      const token = order[1]!, action = order[2];
      if (method === "GET" && !action) return orderPage(yield* store.order(token), token);
      if (method === "GET" && action === "/certificate") return { code: 200, data: yield* store.certificate(token) };
      if (method === "POST" && action && action !== "/certificate") {
        // Authenticate before parsing forms or performing a domain mutation.
        yield* store.order(token);
        const value = yield* form(incoming, action === "/refund-address" ? "address" : undefined);
        if (action === "/invoice") {
          const view = yield* store.quote(token);
          return view.acknowledged ? redirect(token) : orderPage(view, token, 503, "The invoice is being recorded. Try again; no address is shown until the journal acknowledges it.");
        }
        if (action === "/cancel") {
          const view = yield* store.cancel(token);
          return view.cancellation === "final" ? redirect(token) : orderPage(view, token, 202, "Cancellation is unconfirmed until the off-host journal acknowledges it. Don't pay this invoice.");
        }
        const view = yield* store.setRefundDestination(token, value);
        return view.refund_address === value ? redirect(token) : orderPage(view, token, 202, "The refund address is being recorded. Refresh to check its acknowledgment.");
      }
    }
    return notFound();
  }).pipe(Effect.match({ onSuccess: answer => answer, onFailure: refused }));
}
