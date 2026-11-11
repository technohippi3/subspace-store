# Excess fee assessment and deadlines

Converted and issuing fixed-price orders now connect unsigned fee
measurement to excess eligibility and the existing durable refund clocks.
The independent obligation model applies the same fee-plus-546 admission
rule without importing production code. This does not qualify unconverted
outgoing-spend accounting, fulfilled orders or complete K11/K12 production
coverage. No deployment price, risk budget or fee limits are chosen here.

## Canonical estimate

An estimate measures public receipt metadata, not currently spendable
funding. Active six-confirmation receipts for the order are sorted by
outpoint; take enough to represent the unserved principal. Historical
spent receipts remain valid size metadata. The buyer destination and a
P2TR order-change shape, when needed, are measured by Core's unsigned PSBT
analyzer. Public P2TR change placeholders are decoded to network addresses;
no wallet address is allocated and those placeholders never become real
refund outputs. The signed builder continues to allocate its own change.

The rate comes from `estimatesmartfee` and the existing configured
minimum/maximum and optional explicit fallback. An RPC failure is unknown,
not permission to use the fallback. If the base fee is within the buyer's
disclosed ceiling, that is the estimate. Otherwise measure a P2TR merchant
change output too, then add a potential key-path merchant input's weight.
That input is at most 231 weight units (41 base bytes and a witness with a
65-byte signature); allow two marker/flag units and an empty witness byte
per existing input if the template was legacy. Add
`ceil((233 + input_count) / 4)` vbytes. At most 100 real inputs keeps the
input count below the CompactSize boundary. For one input this adds 59
vbytes. This is a canonical estimate, not a prediction of the eventual fee
wallet's input count, script types or fragmentation.

Using one potential fee input keeps eligibility independent of merchant
funding availability. Actual preparation must still select owned settled
coins, measure the signed transaction, enforce fee/refund limits, maintain
the disclosed buyer ceiling and check the actual excess minimum. A fee
estimate never authorizes a spend or changes order credit. Fee movement or
a different actual funding layout cannot erase a clock already admitted.

The weight calculation follows
[witness serialization](https://github.com/bitcoin/bips/blob/master/bip-0141.mediawiki)
and [Taproot key-path signatures](https://github.com/bitcoin/bips/blob/master/bip-0341.mediawiki).
Network address decoding uses Core 31.2's
[script RPC](https://github.com/bitcoin/bitcoin/blob/v31.2/src/rpc/rawtransaction.cpp).

## Admission and unknown estimates

Unserved principal is nonnegative available credit plus each open group's
maximum not yet credited as broadcast. This is the same amount used by
`REFUND-OBLIGATIONS.md`. Eligibility tests the whole currently unserved
amount against estimated network fee plus 546 sats, inclusively. Newly
admitted principal subtracts amounts already on pending clocks. Thus later
money can have a separate deadline while an earlier refund remains
unbroadcast, without restarting that earlier clock or counting a group
twice. A later cancellation releases the price reserve and receives its
own clock, independently of earlier excess broadcasts.

Funds must be settled and a validated destination known. Preparing a
transaction, finding spendable fee coins and journal availability are not
clock prerequisites. Rate/metadata/RPC failures, mismatched tips or a
missing assessment adapter produce `unknown`, never `below_minimum`.
The store journals one operator notice per unresolved unknown episode.
Payment observations still commit and existing clocks still advance.
Recovering and later failing again can open another notice. A small known
estimate starts no new clock; it does not remove old clocks either.

Each latest assessment records principal, observation time, coherent tip,
status and either validated rate/size/fee or null values for unknown.
The buyer sees only its own last assessment and deadline amounts, with no
wallet metadata or operator notices. Assessment time is explicit; it is
not a refund authorization. Operator inspection during a Core outage
ticks persisted clocks but does not manufacture a new estimate.

Payment/refund observation time is captured before optional fee RPCs.
New cancellation/refund-due clocks use that time; new excess clocks use
the time their fee eligibility becomes known. A broadcast observed before
another order's slow fee call retains its first-known time. Apply its
service credit at that time before testing remaining debt at the current
clock, so slow auxiliary RPCs cannot make an on-time payment appear late.
Late credits and genuinely remaining debt still create permanent incidents.

Assessments, notices and clocks use the existing atomic records/journal,
with no database reset or general migration framework. Missing records in
pre-alpha databases begin from current observations and do not claim
historical timeliness. Invalid acknowledged assessment data refuses startup.

## Named cases

| Case | Given | When | Then |
| --- | --- | --- | --- |
| Z50 | public receipt inputs and a buyer fee ceiling | assess with the ceiling covering the base fee or requiring merchant funding, including 100 inputs | measure explicit unsigned shapes, add the bounded key-path fee-input allowance when needed, select no spendable fee coins and allocate no wallet addresses |
| Z51 | converted/issuing excess below six confirmations or missing a destination | satisfy prerequisites and reach fee plus 545/546 sats, then add later funds | no clock below minimum; start at the inclusive boundary before preparation; later admitted amounts have separate starts |
| Z52 | an admitted excess clock or an unknown first estimate | raise/lose the estimate, fail RPC, exceed the rate cap, change tips, lose the journal and restart | unknown is explicit and alerted once per episode, fallback follows policy, and existing clocks/incidents retain their history |
| Z53 | an excess obligation, its broadcast and a later cancellation | evaluate against the independent model | credit the excess once and start only newly released cancellation principal |
| Z54 | stored fee assessment data | change fee arithmetic, eligibility or required fields in an acknowledged record | refuse inconsistent data and startup without rewriting the ledger |
| Z55 | a broadcast observed exactly on target and newly refund-due money | another order's fee RPC advances the clock past the target | retain actual observation time, avoid a false late incident and avoid postponing admission of the refund-due amount |
