import { Stack, localState } from 'alchemy';
import * as Config from 'effect/Config';
import * as Effect from 'effect/Effect';
import { ExistingHost, ExistingHostProvider } from './existing-host.ts';
// Run from a private operator directory. Its .alchemy state/artifacts never
// belong in the public source checkout; the stack persists only references.
export default Stack('subspace-existing-host', { providers: ExistingHostProvider, state: localState() },
  Effect.gen(function* () {
    yield* ExistingHost('seller-installation', {
      configurationReference: yield* Config.String('SUBSPACE_CONFIGURATION_REFERENCE'),
      release: yield* Config.String('SUBSPACE_RELEASE'),
      manifestDigest: yield* Config.String('SUBSPACE_MANIFEST_DIGEST'),
    });
    return {};
  }));
