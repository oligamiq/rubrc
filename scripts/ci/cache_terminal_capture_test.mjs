import test from 'node:test';
import assert from 'node:assert/strict';
import {createCacheTerminalCapture} from './cache_terminal_capture.mjs';

test('records host-routed analyzer output and counts without acknowledgement changes', () => {
  const capture = createCacheTerminalCapture();
  capture.push({session_id: 0xffffffff, data: [...new TextEncoder().encode('analyzer started\n')]});
  assert.deepEqual(capture.snapshot(), {messages: 1, bytes: 17, tail: '[session=4294967295] analyzer started\n'});
});
test('preserves split UTF8 per session and bounds retained output', () => {
  const capture = createCacheTerminalCapture(64);
  const bytes = [...new TextEncoder().encode('あ')];
  capture.push({session_id: 1, data: bytes.slice(0, 2)});
  capture.push({session_id: 2, data: [65]});
  capture.push({session_id: 1, data: bytes.slice(2)});
  assert.match(capture.snapshot().tail, /あ/);
  capture.push({session_id: 1, data: new Array(1000).fill(66)});
  assert.equal(capture.snapshot().tail.length, 64);
  assert.equal(capture.snapshot().bytes, 1004);
});
test('rejects malformed payloads and bounds decoder state', () => {
  assert.throws(() => createCacheTerminalCapture(0));
  const capture = createCacheTerminalCapture();
  for (const payload of [null, {session_id: 1, data: [256]}, {session_id: '1', data: []}]) {
    assert.throws(() => capture.push(payload));
  }
  for (let i = 0; i < 16; i++) capture.push({session_id: i, data: []});
  assert.throws(() => capture.push({session_id: 16, data: []}), /sessions/);
});
