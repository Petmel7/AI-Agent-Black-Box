import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('.', import.meta.url));

describe('Web server/client boundary', () => {
  it('marks every credential, database, and storage module as server-only', async () => {
    const server = new URL('./server/', import.meta.url);
    const files = (await readdir(server)).filter(
      (file) => file.endsWith('.ts') && !file.endsWith('.test.ts'),
    );
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = await readFile(new URL(file, server), 'utf8');
      expect(source, file).toContain("import 'server-only';");
    }
  });

  it('keeps database, storage, credentials, and environment access out of client modules', async () => {
    async function walk(directory: string): Promise<string[]> {
      const entries = await readdir(directory, { withFileTypes: true });
      const nested = await Promise.all(
        entries.map(async (entry) => {
          const path = `${directory}/${entry.name}`;
          if (
            entry.isDirectory() &&
            ['node_modules', '.next'].includes(entry.name)
          )
            return [];
          return entry.isDirectory()
            ? walk(path)
            : /\.(?:ts|tsx)$/.test(entry.name)
              ? [path]
              : [];
        }),
      );
      return nested.flat();
    }
    for (const file of await walk(root)) {
      const source = await readFile(file, 'utf8');
      if (!/^['"]use client['"];?/m.test(source)) continue;
      expect(source, file).not.toMatch(
        /@blackbox\/(?:database|artifact-storage)/,
      );
      expect(source, file).not.toMatch(/(?:\.\.\/)*server\//);
      expect(source, file).not.toContain('process.env');
      expect(source, file).not.toMatch(/DASHBOARD_|DATABASE_URL|SERVICE_ROLE/);
    }
  });

  it('contains no active-content rendering escape hatch', async () => {
    for (const file of await (async function walk(
      directory: string,
    ): Promise<string[]> {
      const entries = await readdir(directory, { withFileTypes: true });
      return (
        await Promise.all(
          entries.map(async (entry) => {
            const path = `${directory}/${entry.name}`;
            if (
              entry.isDirectory() &&
              ['node_modules', '.next'].includes(entry.name)
            )
              return [];
            if (entry.isDirectory()) return walk(path);
            return /\.(?:ts|tsx)$/.test(entry.name) &&
              !/\.test\.(?:ts|tsx)$/.test(entry.name)
              ? [path]
              : [];
          }),
        )
      ).flat();
    })(root)) {
      const source = await readFile(file, 'utf8');
      expect(source).not.toContain('dangerouslySetInnerHTML');
    }
  });

  it('keeps proxy proof and cursor-signing configuration in server-only modules', async () => {
    for (const file of ['app/page.tsx', 'lib/presentation.ts']) {
      const source = await readFile(`${root}/${file}`, 'utf8');
      expect(source).not.toMatch(
        /DASHBOARD_(?:TRUSTED_PROXY_TOKEN_SHA256|CURSOR_SIGNING_KEY)/,
      );
      expect(source).not.toContain('x-blackbox-proxy-token');
    }
  });
});
