# Unsigned refund template assessment

This adds the read-only Core measurement primitive needed before excess
deadline assessment. It does not yet select the refund's coins/change,
evaluate the excess minimum, start excess clocks or complete K11/K12.
Those application rules remain release gaps. No deployment amounts are
chosen here. The store continues to use Effect for its runtime operations;
the estimator returns a typed Effect and has no new dependency.

The caller supplies explicit public input claims, existing destination
templates and a whole-sat-per-1,000-vbyte rate. One to 100 distinct inputs
and one to three distinct output scripts are accepted. Before any RPC,
the component validates whole amounts, the money-supply bound, outpoints,
scripts and destinations. Core validates the destination/network binding.

The component creates a fresh unsigned PSBT, updates wallet metadata with
`walletprocesspsbt(sign=false, finalize=false)` and measures it with
`analyzepsbt`. It checks decoded inputs, their actual previous-output
amounts/scripts, output shapes and the absence of signature/finalization
material. Missing metadata or size, failed RPCs, invalid sizes and a
changing/unready chain or wallet fail the assessment. There is no guessed
size fallback. Fee rounding follows the existing pilot policy: round
rate times estimated vbytes upward to whole sats.

Output amounts are one-satoshi placeholders because amount fields have
fixed width. They are deliberately not a payment plan or a mempool-valid
refund. The synthetic PSBT's own fee is ignored. Only the estimated size,
the fee calculated at the caller's explicit rate and the coherent tip are
returned. No PSBT, raw transaction, signature or wallet derivation data is
returned. A subsequent builder must validate actual amounts, price credit,
fee caps, dust, settled funding, exclusive replacements and acknowledgment
before signing; this measurement authorizes none of those actions.

The estimator calls no signing, funding, input-locking, address-allocation
or broadcast RPC. It never chooses another order's funding. Historical
wallet receipts can be measured after being spent because the wallet still
has their public transaction metadata. That ability says nothing about
whether the inputs are currently spendable. Available funding and deadline
eligibility must remain separate, so missing spendable money cannot
silently postpone a clock whose policy prerequisites already hold.

The pinned Core regtest compares an unsigned Taproot key-path estimate
against an independently signed transaction of the same shape, verifies
unchanged wallet information, UTXOs and input locks around assessment,
and measures the receipt again after its spend confirms. It uses fresh
isolated regtest wallets. No complete fee planner, excess clock or
public-pilot acceptance is claimed.

Core's behavior is checked against the pinned version's
[PSBT analyzer](https://github.com/bitcoin/bitcoin/blob/v31.2/src/node/psbt.cpp)
and [wallet PSBT RPC](https://github.com/bitcoin/bitcoin/blob/v31.2/src/wallet/rpc/spend.cpp).
The public API documents estimated size; actual refund signing must still
measure the final transaction.

## Runtime cases

| Case | Given | When | Then |
| --- | --- | --- | --- |
| Z48 | explicit public inputs, known output templates and a supplied rate | request an unsigned fee assessment | bind size and upward-rounded fee to the coherent tip, use explicit no-sign/no-finalize flags and call no wallet mutation or send RPC |
| Z49 | invalid templates or changed/missing Core metadata | assess while inputs, output scripts, size, signatures, readiness or tip differ | refuse; malformed local templates fail before RPC, and no signed or intermediate transaction is returned |
