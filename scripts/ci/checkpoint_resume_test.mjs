import test from 'node:test';
import assert from 'node:assert/strict';
import {validateResumeRun} from './checkpoint_resume.mjs';

const fixture = () => {
  const run = {id: 123, repository: {full_name: 'oligamiq/rubrc'}, head_repository: {full_name: 'oligamiq/rubrc'},
    path: '.github/workflows/stdlib-cache-ci.yml', head_branch: 'perf/memory-lock-batching',
    event: 'workflow_dispatch', status: 'completed', conclusion: 'failure', head_sha: 'a'.repeat(40)};
  const listing = {total_count: 2, artifacts: ['off', 'on'].map(mode => ({
    name: `checkpoint-batching-${mode}-component`, expired: false, size_in_bytes: 100,
    workflow_run: {id: run.id, head_sha: run.head_sha}}))};
  return {run, listing};
};

test('resume selects producer application source, allowing a failed later stage', () => {
  const {run, listing} = fixture();
  assert.equal(validateResumeRun(run, listing), run.head_sha);
});

test('resume rejects foreign, running and malformed producer identities', () => {
  for (const [key, value] of [['repository', {full_name: 'other/repo'}],
    ['head_repository', {full_name: 'fork/rubrc'}], ['path', 'other.yml'],
    ['head_branch', 'main'], ['event', 'pull_request'], ['status', 'in_progress'], ['head_sha', 'typo']]) {
    const {run, listing} = fixture(); run[key] = value;
    assert.throws(() => validateResumeRun(run, listing), key);
  }
});

test('resume requires both exact unexpired nonempty component artifacts', () => {
  for (const damage of [
    x => x.artifacts.pop(),
    x => { x.artifacts[0].expired = true; },
    x => { x.artifacts[0].size_in_bytes = 0; },
    x => { x.artifacts[0].name = 'checkpoint-batching-off-lower'; },
    x => { x.artifacts[0].workflow_run.id++; },
    x => { x.artifacts[0].workflow_run.head_sha = 'b'.repeat(40); },
    x => { x.artifacts.push(x.artifacts[0]); x.total_count++; },
  ]) {
    const {run, listing} = fixture(); damage(listing);
    assert.throws(() => validateResumeRun(run, listing));
  }
});
