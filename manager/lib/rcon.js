'use strict';

const net = require('net');

const SERVERDATA_AUTH = 3;
const SERVERDATA_AUTH_RESPONSE = 2;
const SERVERDATA_EXECCOMMAND = 2;

function encodePacket(id, type, body = '') {
  const bodyBuffer = Buffer.from(String(body), 'utf8');
  const length = bodyBuffer.length + 10;
  const packet = Buffer.alloc(length + 4);
  packet.writeInt32LE(length, 0);
  packet.writeInt32LE(id, 4);
  packet.writeInt32LE(type, 8);
  bodyBuffer.copy(packet, 12);
  packet.writeInt16LE(0, packet.length - 2);
  return packet;
}

function decodePackets(buffer) {
  const packets = [];
  let offset = 0;
  while (buffer.length - offset >= 4) {
    const length = buffer.readInt32LE(offset);
    if (length < 10 || length > 4 * 1024 * 1024) throw new Error('RCON returned an invalid packet length.');
    if (buffer.length - offset < length + 4) break;
    packets.push({
      id: buffer.readInt32LE(offset + 4),
      type: buffer.readInt32LE(offset + 8),
      body: buffer.subarray(offset + 12, offset + 4 + length - 2).toString('utf8'),
    });
    offset += length + 4;
  }
  return { packets, remainder: buffer.subarray(offset) };
}

function redactRconText(value, secretValues = []) {
  let text = String(value ?? '');
  for (const secret of secretValues.map(String).filter(Boolean)) text = text.split(secret).join('[REDACTED]');
  text = text.replace(/\b(adduser|setpassword|setaccesslevel)\s+(?:"[^"]*"|\S+)\s+(?:"[^"]*"|\S+)/gi, '$1 [REDACTED CREDENTIALS]');
  text = text.replace(/\b(RCONPassword|Password)\s*[=:]\s*\S+/gi, '$1=[REDACTED]');
  return text;
}

class RconClient {
  constructor({ host = '127.0.0.1', port, password, timeoutMs = 6000 }) {
    this.host = host;
    this.port = Number(port);
    this.password = String(password || '');
    this.timeoutMs = timeoutMs;
  }

  execute(command) {
    if (!this.password) return Promise.reject(new Error('RCON password is not configured.'));
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port });
      const authId = Math.floor(Math.random() * 1_000_000) + 1;
      const commandId = authId + 1;
      let authenticated = false;
      let settled = false;
      let buffer = Buffer.alloc(0);
      let response = '';

      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (error) reject(error);
        else resolve(value);
      };

      const timer = setTimeout(() => finish(new Error('RCON request timed out.')), this.timeoutMs);
      timer.unref?.();
      socket.on('error', (error) => finish(new Error(`RCON connection failed: ${error.message}`)));
      socket.on('connect', () => socket.write(encodePacket(authId, SERVERDATA_AUTH, this.password)));
      socket.on('data', (chunk) => {
        try {
          buffer = Buffer.concat([buffer, chunk]);
          const decoded = decodePackets(buffer);
          buffer = decoded.remainder;
          for (const packet of decoded.packets) {
            if (!authenticated && packet.type === SERVERDATA_AUTH_RESPONSE) {
              if (packet.id === -1) return finish(new Error('RCON authentication was rejected.'));
              if (packet.id === authId) {
                authenticated = true;
                socket.write(encodePacket(commandId, SERVERDATA_EXECCOMMAND, command));
                continue;
              }
            }
            if (authenticated && packet.id === commandId) {
              response += packet.body;
              return finish(null, response.trim());
            }
          }
        } catch (error) {
          finish(error);
        }
      });
      socket.on('end', () => {
        if (!settled) finish(authenticated ? null : new Error('RCON closed before authentication.'), response.trim());
      });
    });
  }
}

module.exports = { RconClient, decodePackets, encodePacket, redactRconText };
