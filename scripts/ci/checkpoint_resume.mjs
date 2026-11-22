import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

// This selects the ORIGINAL application source, not the newer workflow harness.
// Optimizer hits still require exact input/tool/flags/source/mode proof validation.
export function validateResumeRun(run, listing) {
  assert.equal(run.repository?.full_name, 'oligamiq/rubrc', 'wrong checkpoint repository');
  assert.equal(run.head_repository?.full_name, 'oligamiq/rubrc', 'fork checkpoint rejected');
  assert.equal(run.path, '.github/workflows/stdlib-cache-ci.yml', 'wrong checkpoint workflow');
  assert.equal(run.head_branch, 'perf/memory-lock-batching', 'wrong experiment branch');
  assert.equal(run.event, 'workflow_dispatch');
  assert.equal(run.status, 'completed', 'checkpoint producer is still running');
  assert.match(run.head_sha ?? '', /^[a-f0-9]{40}$/, 'invalid application source');
  assert.ok(Array.isArray(listing.artifacts), 'missing checkpoint listing');
  assert.equal(listing.total_count, listing.artifacts.length, 'incomplete artifact listing');
  for (const mode of ['off', 'on']) {
    const matches = listing.artifacts.filter(a => a.name === `checkpoint-batching-${mode}-component`);
    assert.equal(matches.length, 1, `one component checkpoint required for ${mode}`);
    assert.equal(matches[0].expired, false, 'checkpoint expired');
    assert.ok(Number.isSafeInteger(matches[0].size_in_bytes) && matches[0].size_in_bytes > 0);
    if (matches[0].workflow_run) {
      assert.equal(matches[0].workflow_run.id, run.id, 'artifact belongs to another run');
      assert.equal(matches[0].workflow_run.head_sha, run.head_sha, 'artifact source mismatch');
    }
  }
  return run.head_sha;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  assert.equal(args.length, 2, 'usage: checkpoint_resume.mjs <run.json> <artifacts.json>');
  const [run, listing] = await Promise.all(args.map(async path => JSON.parse(await readFile(path, 'utf8'))));
  console.log(validateResumeRun(run, listing));
}
