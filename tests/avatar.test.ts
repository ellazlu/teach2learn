import { test } from 'node:test';
import assert from 'node:assert/strict';
import { framesFromManifest, pickFrame } from '../lib/avatar.js';

test('manifest lists frames; unknown names are ignored; formats can mix', () => {
  const f = framesFromManifest({ format: 'webp', frames: ['listening', 'confused.png', 'dancing', 'talking-1'] });
  assert.deepEqual(f, { listening: '/avatar/listening.webp', confused: '/avatar/confused.png', 'talking-1': '/avatar/talking-1.webp' });
  assert.deepEqual(framesFromManifest({ frames: [] }), {});
  assert.deepEqual(framesFromManifest(null), {});
});

test('missing frames fall back sensibly', () => {
  const none = {};
  assert.equal(pickFrame(none, 'confused'), null, 'no art yet -> placeholder');
  const some = { listening: 'L', confused: 'C', 'talking-1': 'T1' };
  assert.equal(pickFrame(some, 'confused'), 'C');
  assert.equal(pickFrame(some, 'curious'), 'L', 'missing expression -> listening');
  assert.equal(pickFrame(some, 'responding', 0), 'T1');
  assert.equal(pickFrame(some, 'responding', 1), 'L', 'no talking-2 -> mouth closes on the listening frame');
  assert.equal(pickFrame({ ...some, 'talking-2': 'T2' }, 'responding', 1), 'T2');
  assert.equal(pickFrame({ listening: 'L' }, 'responding', 0), 'L', 'no talking frames -> stays on listening');
  assert.equal(pickFrame(some, 'listening', 0, true), 'L', 'no blink frame -> no blink');
  assert.equal(pickFrame({ ...some, 'listening-blink': 'B' }, 'listening', 0, true), 'B');
  assert.equal(pickFrame({ confused: 'C' }, 'confused'), null, 'the listening frame is required');
});
