import { test } from 'node:test';
import assert from 'node:assert/strict';
import { framesFromManifest, pickFrame, chooseSet } from '../lib/avatar.js';

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

test('each level uses its own character, else the shared one, never a mix', () => {
  const kid = framesFromManifest({ frames: ['listening', 'confused'] }, '/avatar/kindergarten');
  assert.equal(kid.listening, '/avatar/kindergarten/listening.png');
  const shared = { listening: '/avatar/listening.png', curious: '/avatar/curious.png' };
  assert.equal(chooseSet(kid, shared), kid);
  assert.equal(pickFrame(chooseSet(kid, shared), 'curious'), '/avatar/kindergarten/listening.png', "kid's missing expression stays on the kid's face");
  assert.equal(chooseSet({ confused: '/avatar/high/confused.png' }, shared), shared, 'a level without a listening frame uses the shared character');
  assert.deepEqual(chooseSet({}, {}), {}, 'no art anywhere -> placeholder');
});
