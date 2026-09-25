import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

import type { LocalSpool } from './spool.js';

export interface ArtifactAudit {
  corrupt: number;
  missing: number;
  orphanFinal: number;
  orphanTemporary: number;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function auditArtifacts(spool: LocalSpool): ArtifactAudit {
  const records = spool.artifactIntegrityRecords();
  const referenced = new Set(records.map((record) => record.relativePath));
  const files = readdirSync(spool.artifactDirectory, {
    withFileTypes: true,
  });
  let orphanFinal = 0;
  let orphanTemporary = 0;
  for (const file of files) {
    if (!file.isFile()) continue;
    if (file.name.endsWith('.tmp')) orphanTemporary += 1;
    else if (file.name.endsWith('.artifact') && !referenced.has(file.name))
      orphanFinal += 1;
  }
  let missing = 0;
  let corrupt = 0;
  for (const row of records) {
    const path = join(spool.artifactDirectory, basename(row.relativePath));
    if (!existsSync(path)) {
      missing += 1;
      continue;
    }
    const stat = statSync(path);
    if (
      stat.size !== row.byteLength ||
      sha256(readFileSync(path)) !== row.sha256
    )
      corrupt += 1;
  }
  return { corrupt, missing, orphanFinal, orphanTemporary };
}
