# Native operator commands

The first profile uses an existing Ubuntu 24.04 amd64/systemd 255 host with
Python 3.12 and OpenSSL 3. Core, spaced, the selected wallets, prover and relay
must already be ready. The installer owns the store, subs and HTTPS services.
Use the exact candidate's acceptance record and `NATIVE-PACKAGE.md` alongside
these commands. Paid admission remains subject to the buyer and operator gates.

## Prepare the artifact and host

Keep signing keys, native input profiles, wallet backups and deployment state
outside the public checkout. The native input profile must bind all ten binaries
and their owned build manifests. Assemble from clean reviewed source into a new
directory outside the checkout, then sign with the independently controlled
release key. The shell variables below are explicit operator-selected paths.

```sh
python3 deploy/native/assemble.py --repository "$store_source" \
  --packaging-source "$store_source/deploy" --native-profile "$native_inputs" \
  --destination "$candidate_workspace/payload"
python3 deploy/native/release.py --source "$candidate_workspace/payload" \
  --output "$candidate_workspace/release" --release "$release_id" \
  --source-commit "$source_commit" --signing-key "$offline_signing_key"
python3 deploy/native/profile.py --input "$profile_input" --output "$generated_config"
```

Use `native/profile-input.example.json` as the input shape, replacing every
network, wallet, origin, endpoint, policy and limit with reviewed values.
`native/inspect-native.py --help` describes read-only wallet identity inspection.
For updates, the release builder accepts explicit `--upgrade-from` predecessors
and `--rollback-to` compatible targets. Matching database DDL alone is insufficient.

The profile generator reports the fixed host configuration destination.
Provision its files, the independently trusted release public key, the pinned
recovery SSH host key and the encrypted systemd Infisical bootstrap. The exact
role names and secret scopes appear in generated secrets.json. Prepare original
wallet backups and their digest manifest through the onboarding procedure in
`../docs/spec/HOST-RECOVERY.md`. Keep the decryption key independently recoverable.
Provision the reviewed bootstrap installer with its sibling modules before the
first install; the wallet host receives no release signing secret.

## Install and configure the seller

The same bootstrap entrypoint verifies and applies the signed artifact for both
manual and Alchemy installation:

```sh
sudo python3 "$bootstrap_installer" --config "$installation_config" apply \
  --manifest "$release_manifest" --signature "$release_signature" --artifact "$release_archive"
sudo python3 "$bootstrap_installer" --config "$installation_config" status
sudo python3 "$current_release/native/seller.py" --config "$installation_config" diagnose
sudo python3 "$current_release/native/seller.py" --config "$installation_config" space add "$space"
sudo python3 "$current_release/native/seller.py" --config "$installation_config" name list "$handle" "$price_sats"
sudo python3 "$current_release/native/seller.py" --config "$installation_config" admission set "$window_seconds" "$maximum_requests" "$maximum_orders"
```

A fresh install stays paused with waitingSellerSetup=true and productionReady=false.
Seller changes preview their effects by default. Repeat the reviewed command
with `--apply` to persist it. The same CLI provides price, reservation,
withdrawal, reopening and global or per-space pause operations. Old invoices
retain their acknowledged terms; the review pause at ten conversions remains.
The owner buyer-client test still needs the identified client build and platform.

## Update and recover

Apply a new signed release with the same install command. Live holds and uncertain
operations block maintenance and are reported; there is no fixed drain timer.
A compatible rollback uses that command with `--rollback` and the earlier
verified artifact. Both its compatibility epochs and signed whitelist must match.
Current databases and wallet history survive the rollback.

After restoring original wallet identities and completing rescans, run:

```sh
sudo python3 "$bootstrap_installer" --config "$installation_config" recover --confirm "$installation_id"
```

If Infisical is unavailable, supply protected attended role files and explicitly
add `--attended-credentials`. Both the independent decryption key and storage
credentials are required. Successful recovery starts paused; unknown armed
transactions retain quarantine. Inspect diagnostics instead of clearing flags,
latches or ownership files by hand.

Run the pinned Alchemy CLI from a private operator directory. Supply the opaque
references defined in `alchemy/alchemy.run.ts`, plus SUBSPACE_DEPLOY_CONFIG and
SUBSPACE_RELEASE_DIRECTORY. Its installed CLI accepts `plan` and `deploy` with
the explicit stack-file path and `--stage`. Removing the resource declaration
or destroying its state leaves the host and data intact.
