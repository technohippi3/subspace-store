# Provenance of the imported specification

`PAYMENT-SPEC.md` (draft 8), `CONTROLLER-DESIGN.md` (draft 4) and
`MODEL-PLAN.md` were imported byte for byte from the reviewed checkpoint
`specs-draft8` of the project's private design handoff, frozen on
2026-11-06. Their SHA-256 digests at import:

    d141272a2f408ccdbf11a2a7c68ed8ce5b28cfcbd3217e292826e7442d872fbb  PAYMENT-SPEC.md
    4536e03cc69dbb384e4254455f5a70fd87d1e5ddfcf29f634520ffc439dc71c6  CONTROLLER-DESIGN.md
    06208e618ace8fed80a46e0210f60c25e366fc2ae87cc22884e5ec16c992a2e1  MODEL-PLAN.md

They were left unchanged so that the reviewed bytes can be checked. Where
they mention `README.md`, `REVIEW-5.md` or a numbered ruling, they mean the
private handoff package, which isn't part of this repository.
`ELIGIBILITY.md` is the "Eligibility" section of that handoff README, copied
here because `PAYMENT-SPEC.md` points to it.

From now on this repository is where the specification changes. Each change
is a commit, and the review history stays with the handoff.

On 2026-11-08 two more parts of the handoff were brought in, adapted rather
than byte for byte, so that the launch requirements no longer depend on it:
- `docs/BUYER-GATE.md` is a reviewed version of the handoff's buyer gate
  test plan (draft of 2026-11-06, SHA-256 at adaptation:
  `11c303a35f365186b7a018937caff113fd5c6167a6cfbdbe81db32258ec179cc`). It updates the plan with the regtest findings and the
  2026-11-08 launch scope, refers to the production operator host by role,
  leaves out which spaces the workspace_owner holds, and adds the client
  questions' current state and a transaction plan to fill in.
- "Acceptance gates" in `PAYMENT-SPEC.md` is the handoff README's section
  of that name, unchanged except for the operator gate's two timing
  measurements.
