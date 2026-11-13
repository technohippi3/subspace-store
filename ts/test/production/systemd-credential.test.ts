import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Effect } from 'effect';
import { credentials } from '../../src/runtime/credentials.ts';

test('O151: ordinary group-readable credentials and a forged credential directory stay refused', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'credential-permissions-'));
  const prior = process.env.CREDENTIALS_DIRECTORY;
  t.after(() => { if (prior === undefined) delete process.env.CREDENTIALS_DIRECTORY; else process.env.CREDENTIALS_DIRECTORY = prior; rmSync(root, { recursive: true, force: true }); });
  const operator = join(root, 'operator'), subs = join(root, 'subs');
  writeFileSync(operator, 'o'.repeat(64), { mode: 0o600 });
  writeFileSync(subs, 's'.repeat(64), { mode: 0o600 });
  const pair = credentials({ operator, subs });
  assert.equal(await Effect.runPromise(pair.operator), 'o'.repeat(64));
  chmodSync(operator, 0o440);
  process.env.CREDENTIALS_DIRECTORY = root;
  await assert.rejects(Effect.runPromise(pair.operator));
  process.env.CREDENTIALS_DIRECTORY = '/run/credentials/forged.service';
  await assert.rejects(Effect.runPromise(pair.operator));
});
