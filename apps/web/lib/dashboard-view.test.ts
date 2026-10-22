import { describe, expect, it } from 'vitest';

import {
  boundedJson,
  DashboardInputError,
  displayValue,
  detailTargetHref,
  evidenceHref,
  evidenceReturnHref,
  evidenceReturnTarget,
  findingSupportTargetHref,
  findingReferenceOriginId,
  formatDuration,
  parseDetailSearch,
  parseEvidenceSearch,
  parseEvidencePageSearch,
  parseRunsSearch,
  presentationDescription,
  scopedHref,
  summarySupportOriginId,
} from './dashboard-view';

const uuid = '11111111-1111-4111-8111-111111111111';

describe('dashboard view contract', () => {
  it.each(['PASS', 'REVIEW', 'FAILED', 'INCOMPLETE', 'PROCESSING'])(
    'provides bounded non-overstating wording for %s',
    (state) => {
      const wording = presentationDescription(state);
      expect(wording.length).toBeGreaterThan(20);
      if (state === 'PASS') expect(wording).toContain('not a correctness');
      if (state === 'FAILED') expect(wording).toContain('wrapped process');
    },
  );

  it('keeps missing values unavailable instead of synthesizing zero or success', () => {
    expect(displayValue(null)).toBe('Unavailable');
    expect(formatDuration(null)).toBe('Unavailable');
    expect(displayValue(0)).toBe('0');
  });

  it('bounds structured evidence without interpreting it', () => {
    const value = boundedJson({ hostile: '<script>alert(1)</script>' }, 20);
    expect(value.truncated).toBe(true);
    expect(value.text).toBe('{\n  "hostile": "<scr\n…');
  });

  it('strictly allowlists list and detail query authority', () => {
    expect(parseRunsSearch({ repository: uuid, cursor: 'abc' })).toEqual({
      repositoryId: uuid,
      cursor: 'abc',
    });
    expect(() => parseRunsSearch({ organizationId: uuid })).toThrow(
      DashboardInputError,
    );
    expect(() => parseRunsSearch({ cursor: ['a', 'b'] })).toThrow(
      DashboardInputError,
    );
    expect(parseDetailSearch({ supportClaim: 'a'.repeat(64) })).toEqual({
      cursors: { supportClaim: 'a'.repeat(64) },
      focusFinding: null,
    });
    expect(() => parseDetailSearch({ summarySupports: 'abc' })).toThrow(
      DashboardInputError,
    );
  });

  it('constructs and parses only allowlisted canonical evidence locators', () => {
    const locator = { kind: 'event' as const, eventId: uuid };
    expect(parseEvidenceSearch({ kind: 'event', eventId: uuid })).toEqual(
      locator,
    );
    expect(evidenceHref(uuid, uuid, locator)).toBe(
      `/repositories/${uuid}/runs/${uuid}/evidence?kind=event&eventId=${uuid}`,
    );
    expect(() =>
      parseEvidenceSearch({ kind: 'event', eventId: uuid, storageKey: 'x' }),
    ).toThrow(DashboardInputError);
  });

  it('round-trips a bounded same-run evidence return target and rejects transplantation', () => {
    const resultKey = 'a'.repeat(64);
    const itemId = findingReferenceOriginId(resultKey, 2);
    const target = evidenceReturnTarget(
      uuid,
      uuid,
      { findings: 'signed-finding-page', tools: 'signed-tool-page' },
      'findings',
      itemId,
    );
    const href = evidenceHref(
      uuid,
      uuid,
      { kind: 'finding', resultKey, referenceOrdinal: 2 },
      target,
    );
    const url = new URL(href, 'https://dashboard.invalid');
    const parsed = parseEvidencePageSearch(
      Object.fromEntries(url.searchParams),
      uuid,
      uuid,
    );
    expect(parsed.returnTarget).toEqual(target);
    expect(evidenceReturnHref(parsed.returnTarget!)).toBe(
      `/repositories/${uuid}/runs/${uuid}?tools=signed-tool-page&findings=signed-finding-page#${itemId}`,
    );
    expect(() =>
      parseEvidencePageSearch(
        Object.fromEntries(url.searchParams),
        '22222222-2222-4222-8222-222222222222',
        uuid,
      ),
    ).toThrow(DashboardInputError);
  });

  it('rejects arbitrary return URLs, invalid targets, duplicate values, and non-allowlisted state', () => {
    const base = { kind: 'event', eventId: uuid };
    for (const returnTo of [
      'https://attacker.invalid',
      Buffer.from('{}').toString('base64url'),
      Buffer.from(
        JSON.stringify({
          repositoryId: uuid,
          runId: uuid,
          section: 'summary',
          itemId: `finding-${'a'.repeat(64)}`,
          cursors: {},
        }),
      ).toString('base64url'),
      Buffer.from(
        JSON.stringify({
          repositoryId: uuid,
          runId: uuid,
          section: 'findings',
          itemId: `finding-${'a'.repeat(64)}`,
          cursors: { organizationId: uuid },
        }),
      ).toString('base64url'),
    ])
      expect(() =>
        parseEvidencePageSearch({ ...base, returnTo }, uuid, uuid),
      ).toThrow(DashboardInputError);
    expect(() =>
      parseEvidencePageSearch(
        { ...base, returnTo: ['first', 'second'] },
        uuid,
        uuid,
      ),
    ).toThrow(DashboardInputError);
  });

  it('builds only allowlisted same-run target fragments', () => {
    const claimKey = 'b'.repeat(64);
    const itemId = summarySupportOriginId(claimKey, 1, 'preview');
    expect(
      detailTargetHref(
        uuid,
        uuid,
        { findings: 'signed-findings', tools: 'signed-tools' },
        itemId,
        ['findings'],
      ),
    ).toBe(`/repositories/${uuid}/runs/${uuid}?tools=signed-tools#${itemId}`);
  });

  it('round-trips generated finding-support targets through the strict detail parser', () => {
    const resultKey = 'a'.repeat(64);
    const href = findingSupportTargetHref(
      uuid,
      uuid,
      {
        findings: 'signed-old-findings-page',
        summaryClaims: 'signed-summary-page',
      },
      resultKey,
    );
    const url = new URL(href, 'https://dashboard.invalid');
    expect(url.pathname).toBe(`/repositories/${uuid}/runs/${uuid}`);
    expect(url.hash).toBe(`#finding-${resultKey}`);
    expect(parseDetailSearch(Object.fromEntries(url.searchParams))).toEqual({
      cursors: { summaryClaims: 'signed-summary-page' },
      focusFinding: resultKey,
    });
    expect(url.searchParams.has('findings')).toBe(false);

    expect(() =>
      findingSupportTargetHref(uuid, uuid, {}, 'not-a-result-key'),
    ).toThrow(DashboardInputError);
    expect(() =>
      findingSupportTargetHref(
        uuid,
        '22222222-2222-4222-8222-222222222222',
        { organizationId: uuid },
        resultKey,
      ),
    ).toThrow(DashboardInputError);
  });

  it('constructs back-navigable scoped continuation URLs without stale sibling cursors', () => {
    expect(
      scopedHref(
        `/repositories/${uuid}/runs/${uuid}`,
        { files: 'signed-files', summarySupports: 'signed-old-supports' },
        { supportClaim: 'a'.repeat(64) },
        ['summarySupports'],
      ),
    ).toBe(
      `/repositories/${uuid}/runs/${uuid}?files=signed-files&supportClaim=${'a'.repeat(64)}`,
    );
  });
});
