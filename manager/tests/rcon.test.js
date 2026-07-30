'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { decodePackets, encodePacket, redactRconText } = require('../lib/rcon');

test('RCON packet framing round trips UTF-8 command bodies', () => {
  const packet = encodePacket(17, 2, 'servermsg "Stay inside"');
  assert.equal(packet.readInt32LE(0), packet.length - 4);
  const decoded = decodePackets(packet);
  assert.equal(decoded.remainder.length, 0);
  assert.deepEqual(decoded.packets, [{ id: 17, type: 2, body: 'servermsg "Stay inside"' }]);
});

test('RCON decoder retains partial frames and rejects unsafe lengths', () => {
  const packet = encodePacket(18, 3, 'secret');
  const partial = decodePackets(packet.subarray(0, 8));
  assert.equal(partial.packets.length, 0);
  assert.equal(partial.remainder.length, 8);
  const invalid = Buffer.alloc(4);
  invalid.writeInt32LE(9);
  assert.throws(() => decodePackets(invalid), /invalid packet length/);
});

test('credential-bearing commands and known secrets are redacted', () => {
  const value = 'adduser "Drake" "Hunter-Secret-123" Password=Join-Secret RCONPassword=Rcon-Secret';
  const redacted = redactRconText(value, ['Hunter-Secret-123', 'Join-Secret', 'Rcon-Secret']);
  assert.doesNotMatch(redacted, /Hunter-Secret-123|Join-Secret|Rcon-Secret/);
  assert.match(redacted, /REDACTED/);
});
