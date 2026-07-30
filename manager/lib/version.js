'use strict';

const fs = require('node:fs');

const fileCache = new Map();

function parseGameVersion(content) {
  let version = null;
  for (const match of String(content || '').matchAll(/\bversion=(\d+\.\d+(?:\.\d+)?)\b/gi)) {
    version = match[1];
  }
  return version;
}

function detectGameVersion(candidates) {
  for (const filePath of candidates) {
    try {
      const stat = fs.statSync(filePath);
      const signature = `${stat.size}:${stat.mtimeMs}`;
      let cached = fileCache.get(filePath);
      if (!cached || cached.signature !== signature) {
        cached = { signature, value: parseGameVersion(fs.readFileSync(filePath, 'utf8')) };
        fileCache.set(filePath, cached);
      }
      if (cached.value) return cached.value;
    } catch {}
  }
  return null;
}

module.exports = { detectGameVersion, parseGameVersion };
