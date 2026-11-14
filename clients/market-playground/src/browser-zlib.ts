// just-bash's browser bundle retains a node:zlib import for gzip files.
// Supply real browser compression implementations rather than a Node stub.
import { gzipSync as gzip, Gunzip } from 'fflate';
export const constants = { Z_BEST_COMPRESSION: 9, Z_BEST_SPEED: 1, Z_DEFAULT_COMPRESSION: -1 };
type Options = { level?: number; maxOutputLength?: number };
export function gzipSync(input: Uint8Array, options: Options = {}) {
  const level = options.level === -1 ? 6 : options.level;
  const output = gzip(input, { level: level as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | undefined });
  if (output.length > (options.maxOutputLength ?? 16 * 1024 * 1024)) throw new Error('gzip output limit exceeded');
  return output;
}
export function gunzipSync(input: Uint8Array, options: Options = {}) {
  const chunks: Uint8Array[] = [];
  const max = options.maxOutputLength ?? 16 * 1024 * 1024;
  let size = 0;
  const stream = new Gunzip(chunk => {
    size += chunk.length;
    if (size > max) throw new Error('gunzip output limit exceeded');
    chunks.push(chunk);
  });
  for (let offset = 0; offset < input.length; offset += 1024) stream.push(input.subarray(offset, offset + 1024), offset + 1024 >= input.length);
  const output = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
  return output;
}
