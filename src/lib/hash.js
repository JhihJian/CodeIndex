import crypto from 'node:crypto';

export function hashBytes(value, algorithm = 'sha256') {
  return crypto.createHash(algorithm).update(value).digest('hex');
}

export function hashText(value, algorithm = 'sha256') {
  return hashBytes(Buffer.from(String(value), 'utf8'), algorithm);
}

export function shortHash(value, length = 16) {
  return hashText(value).slice(0, length);
}

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
