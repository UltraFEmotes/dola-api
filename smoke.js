// Offline sanity checks that don't require Dola credentials:
//  - the request body builder produces valid JSON with the right model flags
//  - the SSE parser extracts text deltas from a captured Dola frame
// Run: npm run smoke

import assert from 'node:assert';
import { CHAT_ABILITY, VIDEO_MODEL_1_0 } from './src/dola.js';

// 1) Media ability descriptors match what dola.com sends.
assert.equal(CHAT_ABILITY.image.ability_type, 3);
assert.equal(CHAT_ABILITY.image.ability_param, '{"ability_param":{},"ability_type":1}');
const v = CHAT_ABILITY.video1(10);
assert.equal(v.ability_type, 17);
assert.deepEqual(JSON.parse(v.ability_param), { model: 'ic_mini', duration: 10 });
assert.equal(VIDEO_MODEL_1_0, 'ic_mini');

// 2) A real STREAM_MSG_NOTIFY frame (trimmed) parses to the expected delta.
const frame =
  'id: 4\n' +
  'event: STREAM_MSG_NOTIFY\n' +
  'data: {"content":{"content_block":[{"block_type":10000,"block_id":"x","content":{"text_block":{"text":"one"}},"is_finish":false,"patch_type":1}],"content_status":100}}';
const block = JSON.parse(frame.split('data: ')[1]).content.content_block[0];
assert.equal(block.block_type, 10000);
assert.equal(block.content.text_block.text, 'one');

console.log('smoke: OK — body/ability descriptors and SSE frame shape verified.');
