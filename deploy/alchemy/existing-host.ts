import { Resource } from 'alchemy';
import * as Provider from 'alchemy/Provider';
import * as Effect from 'effect/Effect';
import * as Data from 'effect/Data';
import { isResolved } from 'alchemy/Diff';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as Transport from './transport.ts';

export interface Props { configurationReference: string; release: string; manifestDigest: string }
export interface Attributes { release: string; manifestDigest: string; ready: boolean; paused: boolean }
export interface ExistingHost extends Resource<'Subspace.ExistingHost', Props, Attributes> {}
export const ExistingHost = Resource<ExistingHost>('Subspace.ExistingHost');
class DeploymentError extends Data.TaggedError('DeploymentError')<{ message: string }> {}
const attempt = <T>(body: () => Promise<T>) => Effect.tryPromise({ try: body,
  catch: () => new DeploymentError({ message: 'Existing host deployment or readiness refused; inspect private host diagnostics' }) });
export const ExistingHostProvider = Provider.succeed(ExistingHost, {
  nuke: { skip: true },
  read: ({ olds }) => attempt(async () => {
    const output = await Transport.status(Transport.host(olds.configurationReference));
    return output.release === null ? undefined : { release: output.release, manifestDigest: output.manifestDigest ?? '', ready: output.ready, paused: output.paused };
  }),
  diff: ({ news, output }) => {
    if (!isResolved(news)) return Effect.succeed(undefined);
    return Effect.succeed(output?.ready && output.manifestDigest === (news as Props).manifestDigest ? { action: 'noop' as const } : { action: 'update' as const });
  },
  reconcile: ({ news }) => attempt(async () => {
    const directory = process.env.SUBSPACE_RELEASE_DIRECTORY;
    if (!directory || !/^[a-zA-Z0-9_./-]+$/.test(directory) || !/^[0-9a-f]{64}$/.test(news.manifestDigest)) throw Error('release reference refused');
    const manifest = readFileSync(join(directory, 'manifest.json'));
    if (manifest.length > 16 * 1024 * 1024 || createHash('sha256').update(manifest).digest('hex') !== news.manifestDigest || JSON.parse(manifest.toString()).release !== news.release)
      throw Error('release reference refused');
    const host = Transport.host(news.configurationReference);
    await Transport.apply(host, directory, news.manifestDigest);
    const output = await Transport.status(host);
    if (output.release !== news.release || output.manifestDigest !== news.manifestDigest || !output.ready) throw Error('replacement not ready');
    return { release: output.release, manifestDigest: output.manifestDigest, ready: output.ready, paused: output.paused };
  }),
  // Removing the declaration or destroying its state performs zero host I/O.
  delete: () => Effect.void,
});
