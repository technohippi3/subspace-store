// Runs the real pinned Alchemy lifecycle against only a disposable test host.
import { Stack, localState } from 'alchemy';
import * as Alchemist from 'alchemy/Alchemist';
import * as Effect from 'effect/Effect';
import { ExistingHost, ExistingHostProvider } from './existing-host.ts';
const operation = process.argv[2];
if (!['deploy', 'remove', 'destroy'].includes(operation)) throw Error('fixture operation required');
const stack = Stack('subspace-existing-host-fixture', { providers: ExistingHostProvider, state: localState() }, Effect.gen(function* () {
  if (operation !== 'remove') yield* ExistingHost('seller-installation', {
    configurationReference: 'fixture', release: process.env.SUBSPACE_RELEASE!, manifestDigest: process.env.SUBSPACE_MANIFEST_DIGEST!,
  });
  return {};
}));
await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const plan = yield* Alchemist.plan({ stack, stage: 'qualification', operation: operation === 'destroy' ? 'destroy' : 'deploy' });
  yield* Alchemist.apply(plan);
})).pipe(Effect.provide(Alchemist.layer())));
console.log(JSON.stringify({ ok: true, operation }));
