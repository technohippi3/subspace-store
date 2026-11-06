# Eligibility

The registry enforces eligibility. The Spaces commitment doesn't, so an
operator could issue outside its own policy. Published evidence makes issuance
auditable, not enforced. Names can be transferred, so copy says "verified when
issued".

Each proof is bound to a canonical order payload: store domain, space, name,
recipient script, policy version and nonce. Its hash goes in ZKPassport's
`custom_data`. The server keeps the original query and verifies with
`verifierMode: "local"`; the SDK's default `auto` falls back to ZKPassport's
API (SDK commit `dae2129`). Tests reject an altered name, an altered
recipient, the wrong scope and a replay.

The quota scope (space plus policy) is stable across orders, and uniqueness is
enforced in one database transaction. Which evidence becomes public is
undecided, because publishing a nullifier links a holder's purchases.
ZKPassport's identifier is scoped per domain, so the store lives on one fixed
domain. Its SDK has not had an external audit.

