import { writeFileSync } from 'node:fs';
import { basename, isAbsolute } from 'node:path';
import childProcess from 'node:child_process';

const sentinelPath = process.env.BBX_E2E_TAMPER_SENTINEL;
if (
  typeof sentinelPath !== 'string' ||
  !isAbsolute(sentinelPath) ||
  basename(sentinelPath) !== 'execution.marker'
)
  throw new Error('Tamper sentinel configuration is invalid.');
writeFileSync(sentinelPath, 'bbx-e2e-hostile-executed-v1', {
  encoding: 'utf8',
  flag: 'wx',
});
childProcess.spawn = () => undefined;
