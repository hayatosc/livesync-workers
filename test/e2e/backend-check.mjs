// Actual local Workers/R2/DO prerequisite check. This is NOT an Obsidian E2E test.
import assert from 'node:assert/strict';
import { startBackend } from './backend.mjs';
const backend = await startBackend();
try {
  assert.equal((await backend.request('a', '', { method: 'PUT' })).status, 200);
  assert.equal((await backend.request('b', '', { method: 'PUT' })).status, 200);
  assert.equal(
    (await backend.request('a', '/probe', { method: 'PUT', body: JSON.stringify({ data: '東京 😀', type: 'plain' }) }))
      .status,
    200,
  );
  assert.equal((await backend.request('b', '/probe')).status, 404);
  await backend.reset('a');
  await backend.restart();
  assert.equal((await (await backend.request('a', '/probe')).json()).data, '東京 😀');
  console.log('PASS local backend: Workers/R2/DO, isolation, cache recovery and restart (no Obsidian)');
} finally {
  await backend.dispose();
}
