import { createHash } from 'node:crypto';

export function computeFileChecksum(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}
