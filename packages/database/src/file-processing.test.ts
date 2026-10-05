import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  FileProcessingError,
  parseGitFileListArtifact,
} from './file-processing.js';

const fixture = readFileSync(
  new URL(
    '../../contracts/src/fixtures/git-file-list-v1.json',
    import.meta.url,
  ),
);
const ownership = {
  diffId: '00000000-0000-4000-8000-000000000001',
  fromSnapshotId: '00000000-0000-4000-8000-000000000002',
  toSnapshotId: '00000000-0000-4000-8000-000000000003',
};

describe('Git file-list artifact parser', () => {
  it('strictly parses the collector-compatible fixture and preserves temporal attribution', () => {
    const value = parseGitFileListArtifact(fixture, ownership);
    expect(value.attributionIsTemporalNotCausal).toBe(true);
    expect(value.files[0]).toMatchObject({
      entryId: 'b'.repeat(64),
      displayAmbiguous: true,
      attribution: 'mixed-or-uncertain',
      before: { entryId: 'a'.repeat(64), path: 'old.txt' },
      after: { entryId: 'b'.repeat(64), path: '[REDACTED]', binary: true },
    });
  });

  it.each([
    ['file_artifact_invalid_utf8', Buffer.from([0xff])],
    [
      'file_artifact_invalid_utf8',
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), fixture]),
    ],
    ['file_artifact_invalid_json', Buffer.from('{')],
    ['file_artifact_schema_invalid', Buffer.from('{"schemaVersion":2}')],
  ])('returns safe terminal %s errors', (code, bytes) => {
    expect(() => parseGitFileListArtifact(bytes, ownership)).toThrow(
      expect.objectContaining<Partial<FileProcessingError>>({
        code,
        retryable: false,
      }),
    );
  });

  it('rejects a root identity that does not match the owning canonical diff', () => {
    expect(() =>
      parseGitFileListArtifact(fixture, {
        ...ownership,
        diffId: '00000000-0000-4000-8000-000000000099',
      }),
    ).toThrow(
      expect.objectContaining<Partial<FileProcessingError>>({
        code: 'file_artifact_root_identity_mismatch',
      }),
    );
  });
});
