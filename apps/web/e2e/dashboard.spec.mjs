import { expect, test } from '@playwright/test';

import { replaceRunListSourceSnapshot } from '../test/e2e-database-control.mjs';
import {
  exclusivePaginationState,
  renderedPageMatchesCursor,
  sanitizedDigest,
  stableItemMarker,
} from '../test/e2e-pagination-transition.ts';
import { parseDetailSearch } from '../lib/dashboard-view.ts';

const repositoryId = process.env.BBX_E2E_REPOSITORY_ID;
const runId = process.env.BBX_E2E_RUN_ID;
const reviewRunId = process.env.BBX_E2E_REVIEW_RUN_ID;
const supportClaimKey = process.env.BBX_E2E_SUPPORT_CLAIM_KEY;
const secretSentinel = process.env.BBX_E2E_SECRET_SENTINEL;
const missingRepositoryId = '99999999-9999-4999-8999-999999999999';
const collectionLabels = {
  runs: 'runs',
  commands: 'commands',
  tests: 'tests',
  tools: 'tools',
  'git-snapshots': 'git snapshots',
  'git-diffs': 'git diffs',
  errors: 'errors',
  usage: 'usage',
  timeline: 'timeline',
  files: 'files',
  findings: 'findings',
  'summary-claims': 'summary claims',
  'summary-supports': 'summary supports',
};

const collectionCursorNames = {
  runs: 'cursor',
  commands: 'commands',
  tests: 'tests',
  tools: 'tools',
  'git-snapshots': 'gitSnapshots',
  'git-diffs': 'gitDiffs',
  errors: 'errors',
  usage: 'usage',
  timeline: 'timeline',
  files: 'files',
  findings: 'findings',
  'summary-claims': 'summaryClaims',
  'summary-supports': 'summarySupports',
};

const runsQueryNames = new Set(['repository', 'cursor']);
const detailQueryNames = new Set([
  'commands',
  'tools',
  'tests',
  'gitSnapshots',
  'gitDiffs',
  'errors',
  'usage',
  'files',
  'findings',
  'summaryClaims',
  'timeline',
  'supportClaim',
  'summarySupports',
  'focusFinding',
]);

function sanitizedPathname(value) {
  return value.replace(
    /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi,
    '<canonical-id>',
  );
}

function publicLocation(url, collection) {
  const parsed = new URL(url);
  const queryNames = [...parsed.searchParams.keys()].sort();
  const allowed = collection === 'runs' ? runsQueryNames : detailQueryNames;
  expect(queryNames.every((name) => allowed.has(name))).toBe(true);
  const cursor = parsed.searchParams.get(collectionCursorNames[collection]);
  return {
    pathname: parsed.pathname,
    queryNames,
    cursorDigest: sanitizedDigest(cursor),
  };
}

function fixtureCollectionCounts() {
  const raw = process.env.BBX_E2E_COLLECTION_COUNTS;
  if (!raw) throw new Error('The E2E child-collection counts are required.');
  const parsed = JSON.parse(raw);
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    Object.keys(parsed).sort().join(',') !==
      Object.keys(collectionLabels).sort().join(',') ||
    Object.values(parsed).some(
      (value) => !Number.isSafeInteger(value) || value < 0,
    )
  )
    throw new Error('The E2E child-collection counts are invalid.');
  return parsed;
}

async function traverseCollection(page, detailUrl, collection, expectedCount) {
  const label = collectionLabels[collection];
  await page.goto(detailUrl);
  const expectedPathname = new URL(detailUrl, 'http://127.0.0.1').pathname;
  const seen = new Map();
  let expectedNavigation = null;
  for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
    const location = publicLocation(page.url(), collection);
    expect(location.pathname).toBe(expectedPathname);
    const keys = await page
      .locator(`[data-dashboard-collection="${collection}"]`)
      .evaluateAll((elements) =>
        elements.map((element) => element.dataset.dashboardItemKey),
      );
    const withinPage = new Set();
    let duplicate = null;
    for (const [itemIndex, key] of keys.entries()) {
      expect(typeof key === 'string' && key.length > 0).toBe(true);
      expect(withinPage.has(key)).toBe(false);
      withinPage.add(key);
      const first = seen.get(key);
      if (first && duplicate === null)
        duplicate = {
          key,
          firstPage: first.pageIndex,
          firstIndex: first.itemIndex,
          secondPage: pageNumber + 1,
          secondIndex: itemIndex + 1,
        };
      if (!first)
        seen.set(key, { pageIndex: pageNumber + 1, itemIndex: itemIndex + 1 });
    }
    const next = page.getByRole('link', {
      name: `Next ${label} page`,
      exact: true,
    });
    const terminal = page.locator(`[data-terminal-collection="${label}"]`);
    await expect
      .poll(async () =>
        exclusivePaginationState(await next.count(), await terminal.count()),
      )
      .not.toBeNull();
    const [nextCount, terminalCount] = await Promise.all([
      next.count(),
      terminal.count(),
    ]);
    const paginationState = exclusivePaginationState(nextCount, terminalCount);
    expect(paginationState).not.toBeNull();
    let nextCursorDigest = null;
    let nextUrl = null;
    if (nextCount === 1) {
      const href = await next.getAttribute('href');
      expect(href).toBeTruthy();
      nextUrl = new URL(href, page.url());
      const nextLocation = publicLocation(nextUrl.href, collection);
      expect(nextLocation.pathname).toBe(expectedPathname);
      nextCursorDigest = nextLocation.cursorDigest;
      expect(nextCursorDigest).not.toBeNull();
      expect(nextCursorDigest).not.toBe(location.cursorDigest);
    }
    const itemMarkerDigest = stableItemMarker(keys);
    const markerAdvanced =
      expectedNavigation === null ||
      (location.cursorDigest === expectedNavigation.cursorDigest &&
        itemMarkerDigest !== expectedNavigation.previousItemMarkerDigest);
    const record = {
      collection,
      pageIndex: pageNumber + 1,
      pathname: sanitizedPathname(location.pathname),
      queryNames: location.queryNames,
      cursorDigest: location.cursorDigest,
      itemCount: keys.length,
      orderedStableItemKeyDigests: keys.map((key) => sanitizedDigest(key)),
      itemMarkerDigest,
      terminal: paginationState === 'terminal',
      nextPage: paginationState === 'next',
      nextCursorDigest,
      renderedMarkerMatchesCursor: markerAdvanced,
      ...(duplicate === null
        ? {}
        : {
            duplicate: {
              ...duplicate,
              key: undefined,
              keyDigest: sanitizedDigest(duplicate.key),
            },
          }),
    };
    console.log(`BBX_E2E_TRAVERSAL ${JSON.stringify(record)}`);
    if (duplicate !== null)
      throw new Error(
        `Duplicate ${collection} key digest ${sanitizedDigest(duplicate.key)} at page/index ${duplicate.firstPage}/${duplicate.firstIndex} and ${duplicate.secondPage}/${duplicate.secondIndex}.`,
      );
    expect(markerAdvanced).toBe(true);
    if (paginationState === 'terminal') {
      await expect(terminal).toBeVisible();
      break;
    }
    expect(seen.size).toBeLessThan(expectedCount);
    expectedNavigation = {
      cursorDigest: nextCursorDigest,
      previousItemMarkerDigest: itemMarkerDigest,
    };
    await next.evaluate((element) => element.click());
    await expect
      .poll(() => {
        const actual = new URL(page.url());
        return (
          actual.pathname === nextUrl.pathname &&
          actual.search === nextUrl.search
        );
      })
      .toBe(true);
    await expect
      .poll(async () => {
        const actualLocation = publicLocation(page.url(), collection);
        const actualKeys = await page
          .locator(`[data-dashboard-collection="${collection}"]`)
          .evaluateAll((elements) =>
            elements.map((element) => element.dataset.dashboardItemKey),
          );
        return renderedPageMatchesCursor({
          expectedCursorDigest: expectedNavigation.cursorDigest,
          actualCursorDigest: actualLocation.cursorDigest,
          previousItemMarker: expectedNavigation.previousItemMarkerDigest,
          actualItemMarker: stableItemMarker(actualKeys),
        });
      })
      .toBe(true);
    if (pageNumber === 99)
      throw new Error(`Collection ${collection} did not terminate.`);
  }
  expect(seen.size).toBe(expectedCount);
}

async function collectFindingReferenceCases(page, detailUrl) {
  const cases = [];
  const seenFindings = new Set();
  let current = detailUrl;
  for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
    await page.goto(current);
    const findings = page.locator('[data-dashboard-collection="findings"]');
    for (let index = 0; index < (await findings.count()); index += 1) {
      const finding = findings.nth(index);
      const findingId = await finding.getAttribute('id');
      expect(findingId).toBeTruthy();
      expect(seenFindings.has(findingId)).toBe(false);
      seenFindings.add(findingId);
      const referenceIds = await finding
        .locator('[data-finding-reference]')
        .evaluateAll((elements) => elements.map((element) => element.id));
      if (referenceIds.length === 0)
        await expect(finding).toContainText(
          'No navigable immutable evidence reference is available',
        );
      cases.push({ pageUrl: page.url(), findingId, referenceIds });
    }
    const next = page.getByRole('link', {
      name: 'Next findings page',
      exact: true,
    });
    if ((await next.count()) === 0) break;
    current = new URL(await next.getAttribute('href'), page.url()).href;
  }
  return cases;
}

async function followEveryFindingReference(page, cases) {
  for (const findingCase of cases) {
    for (const referenceId of findingCase.referenceIds) {
      await page.goto(findingCase.pageUrl);
      const reference = page.locator(`#${referenceId}`);
      await reference.getByRole('link').click();
      await expect(
        page.getByRole('heading', { name: 'Evidence detail' }),
      ).toBeVisible();
      await page.goBack();
      await expect(page.locator(`#${referenceId}`)).toBeFocused();
    }
  }
}

async function collectSummarySupports(page, detailUrl) {
  const supports = [];
  const seen = new Set();
  let current = `${detailUrl}?supportClaim=${supportClaimKey}`;
  for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
    await page.goto(current);
    const items = page.locator(
      '[data-dashboard-collection="summary-supports"]',
    );
    for (let index = 0; index < (await items.count()); index += 1) {
      const item = items.nth(index);
      const id = await item.getAttribute('id');
      const kind = await item.getAttribute('data-summary-support-kind');
      expect(id).toBeTruthy();
      expect(kind === 'evidence' || kind === 'finding').toBe(true);
      expect(seen.has(id)).toBe(false);
      seen.add(id);
      let findingNavigation = null;
      if (kind === 'finding') {
        const href = await item.getByRole('link').getAttribute('href');
        expect(href).toBeTruthy();
        const destination = new URL(href, page.url());
        const source = new URL(page.url());
        const match = id.match(
          /^summary-support-(?:preview|page)-([0-9a-f]{64})-(\d{1,2})$/,
        );
        expect(match).not.toBeNull();
        const queryEntries = [...destination.searchParams.entries()];
        const queryNames = queryEntries.map(([name]) => name).sort();
        const parameterCounts = new Map();
        for (const [name] of queryEntries)
          parameterCounts.set(name, (parameterCounts.get(name) ?? 0) + 1);
        const duplicateParameters = [...parameterCounts.entries()]
          .filter(([, count]) => count !== 1)
          .map(([name]) => name);
        expect(duplicateParameters).toEqual([]);
        let parserPassed = false;
        let validationBranch = 'parseDetailSearch.rejected';
        try {
          parseDetailSearch(Object.fromEntries(queryEntries));
          parserPassed = true;
          validationBranch = 'parseDetailSearch.accepted';
        } catch (error) {
          validationBranch =
            error?.name === 'DashboardInputError'
              ? 'parseDetailSearch.dashboard_input_error'
              : 'parseDetailSearch.unexpected_error';
        }
        const resultKey = destination.searchParams.get('focusFinding');
        expect(resultKey).toMatch(/^[0-9a-f]{64}$/);
        const loadedFindingKeys = await page
          .locator('[data-dashboard-collection="findings"]')
          .evaluateAll((elements) =>
            elements.map((element) => element.dataset.dashboardItemKey),
          );
        findingNavigation = {
          claimKeyDigest: sanitizedDigest(match[1]),
          supportOrdinal: Number(match[2]),
          supportKind: kind,
          findingResultKeyDigest: sanitizedDigest(resultKey),
          sourcePathname: sanitizedPathname(source.pathname),
          destinationPathname: sanitizedPathname(destination.pathname),
          queryParameterNames: queryNames,
          queryValueLengths: Object.fromEntries(
            queryEntries.map(([name, value]) => [name, value.length]),
          ),
          parserPassed,
          parameterParserResults: Object.fromEntries(
            queryNames.map((name) => [name, parserPassed]),
          ),
          dashboardInputSafeCode: parserPassed ? null : 'DashboardInputError',
          validationBranch,
          targetOnCurrentFindingsPage: loadedFindingKeys.includes(resultKey),
        };
        console.log(
          `BBX_E2E_FINDING_SUPPORT ${JSON.stringify(findingNavigation)}`,
        );
      }
      supports.push({ pageUrl: page.url(), id, kind, findingNavigation });
    }
    const next = page.getByRole('link', {
      name: 'Next summary supports page',
      exact: true,
    });
    const terminal = page.locator(
      '[data-terminal-collection="summary supports"]',
    );
    const state = exclusivePaginationState(
      await next.count(),
      await terminal.count(),
    );
    expect(state).not.toBeNull();
    if (state === 'terminal') break;
    current = new URL(await next.getAttribute('href'), page.url()).href;
    if (pageNumber === 99)
      throw new Error('Summary support collection did not terminate.');
  }
  expect(supports).toHaveLength(fixtureCollectionCounts()['summary-supports']);
  return supports;
}

async function followPreviewFindingSupport(page, detailUrl) {
  let current = detailUrl;
  for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
    await page.goto(current);
    const support = page
      .locator(
        '[data-dashboard-collection^="summary-support-preview-"][data-summary-support-kind="finding"]',
      )
      .first();
    if ((await support.count()) === 1) {
      const originId = await support.getAttribute('id');
      expect(originId).toBeTruthy();
      const href = await support.getByRole('link').getAttribute('href');
      expect(href).toBeTruthy();
      expect(
        new URL(href, page.url()).searchParams.has('referenceOrdinal'),
      ).toBe(false);
      await support.getByRole('link').click();
      await expect(
        page.locator('[data-dashboard-collection="findings"]:focus'),
      ).toHaveCount(1);
      await page.goBack();
      await expect(page.locator(`#${originId}`)).toBeFocused();
      return;
    }
    const next = page.getByRole('link', {
      name: 'Next summary claims page',
      exact: true,
    });
    if ((await next.count()) === 0)
      throw new Error('No finding-backed summary support was reachable.');
    current = new URL(await next.getAttribute('href'), page.url()).href;
  }
  throw new Error('Summary claim traversal did not terminate.');
}

const publicResponseHeaders = [
  'cache-control',
  'content-security-policy',
  'content-type',
  'location',
  'permissions-policy',
  'referrer-policy',
  'vary',
  'x-content-type-options',
  'x-frame-options',
];

function relevantHeaders(response) {
  const headers = response.headers();
  return Object.fromEntries(
    publicResponseHeaders.map((name) => [name, headers[name] ?? null]),
  );
}

function normalizeRequestedRepository(body, requestedRepositoryId) {
  return body
    .replaceAll(requestedRepositoryId, '<requested-repository-id>')
    .replaceAll(
      encodeURIComponent(requestedRepositoryId),
      '<requested-repository-id>',
    );
}

async function observeGenericNotFound(page, requestedRepositoryId) {
  const response = await page.goto(
    `/repositories/${requestedRepositoryId}/runs/${runId}`,
  );
  if (!response)
    throw new Error('The not-found navigation returned no response.');
  await expect(
    page.getByRole('heading', { name: 'Evidence view unavailable' }),
  ).toBeVisible();
  const main = page.getByRole('main');
  return {
    status: response.status(),
    headers: relevantHeaders(response),
    redirected: response.request().redirectedFrom() !== null,
    visible: await main.evaluate((element) => ({
      id: element.id,
      role: element.getAttribute('role'),
      tabIndex: element.tabIndex,
      text: element.innerText.replace(/\s+/g, ' ').trim(),
      headings: Array.from(element.querySelectorAll('h1, h2, h3')).map(
        (heading) => ({ level: heading.tagName, text: heading.textContent }),
      ),
      links: Array.from(element.querySelectorAll('a')).map((link) => ({
        href: link.getAttribute('href'),
        text: link.textContent,
      })),
    })),
    body: normalizeRequestedRepository(
      await response.text(),
      requestedRepositoryId,
    ),
  };
}

test.beforeAll(() => {
  if (
    !repositoryId ||
    !runId ||
    !reviewRunId ||
    !supportClaimKey ||
    !/^[0-9a-f]{64}$/.test(supportClaimKey) ||
    !secretSentinel
  )
    throw new Error('The deterministic BBX-012B fixture identity is required.');
  fixtureCollectionCounts();
});

test('challenges unauthenticated requests at the real proxy boundary', async ({
  baseURL,
}) => {
  if (!baseURL) throw new Error('The dashboard E2E base URL is required.');
  const response = await fetch(new URL('/runs', baseURL), {
    redirect: 'manual',
  });
  expect(response.status).toBe(401);
  expect(response.headers.get('www-authenticate')).toContain('Basic');
  expect(response.headers.get('cache-control')).toBe('no-store');
});

test('navigates list, independent states, supports, evidence, and pages', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto('/runs');
  await expect(
    page.getByRole('heading', { name: 'Recorded runs' }),
  ).toBeVisible();
  for (const state of ['PASS', 'REVIEW', 'FAILED', 'INCOMPLETE', 'PROCESSING'])
    await expect(page.getByText(state, { exact: true }).first()).toBeVisible();
  await page.getByRole('link', { name: new RegExp(runId) }).click();
  await expect(page).toHaveURL(
    new RegExp(`/repositories/${repositoryId}/runs/${runId}`),
  );
  await expect(page.getByRole('main')).toBeFocused();
  for (const heading of [
    'Overview',
    'Structured summary',
    'Deterministic findings',
    'Changed files',
    'Commands',
    'Explicit test observations',
    'Tool calls',
    'Git snapshots and diffs',
    'Observed errors',
    'Usage observations',
    'Canonical timeline',
  ])
    await expect(page.getByRole('heading', { name: heading })).toBeVisible();
  const detailUrl = `/repositories/${repositoryId}/runs/${runId}`;
  const counts = fixtureCollectionCounts();
  for (const [collection, expectedCount] of Object.entries(counts))
    await traverseCollection(
      page,
      collection === 'runs'
        ? '/runs'
        : collection === 'summary-supports'
          ? `/repositories/${repositoryId}/runs/${reviewRunId}?supportClaim=${supportClaimKey}`
          : detailUrl,
      collection,
      expectedCount,
    );

  const reviewUrl = `/repositories/${repositoryId}/runs/${reviewRunId}`;
  const findingCases = await collectFindingReferenceCases(page, reviewUrl);
  expect(findingCases.some((value) => value.referenceIds.length > 0)).toBe(
    true,
  );
  expect(findingCases.some((value) => value.referenceIds.length === 0)).toBe(
    true,
  );
  await followEveryFindingReference(page, findingCases);
  await followPreviewFindingSupport(page, reviewUrl);

  const supports = await collectSummarySupports(page, reviewUrl);
  for (const support of supports) {
    await page.goto(support.pageUrl);
    const origin = page.locator(`#${support.id}`);
    await origin.getByRole('link').click();
    if (support.kind === 'evidence') {
      await expect(
        page.getByRole('heading', { name: 'Evidence detail' }),
      ).toBeVisible();
      await page.goBack();
      await expect(page.locator(`#${support.id}`)).toBeFocused();
    } else {
      const focusedFinding = page.locator(
        '[data-dashboard-collection="findings"]:focus',
      );
      await expect(focusedFinding).toHaveCount(1);
      const focusedResultKey = await focusedFinding.getAttribute(
        'data-dashboard-item-key',
      );
      expect(sanitizedDigest(focusedResultKey)).toBe(
        support.findingNavigation.findingResultKeyDigest,
      );
      const referenceIds = await focusedFinding
        .locator('[data-finding-reference]')
        .evaluateAll((elements) => elements.map((element) => element.id));
      if (referenceIds.length === 0)
        await expect(focusedFinding).toContainText(
          'No navigable immutable evidence reference is available',
        );
      for (const referenceId of referenceIds) {
        const reference = page.locator(`#${referenceId}`);
        await reference.getByRole('link').click();
        await expect(
          page.getByRole('heading', { name: 'Evidence detail' }),
        ).toBeVisible();
        await page.goBack();
        await expect(page.locator(`#${referenceId}`)).toBeFocused();
      }
      await page.goBack();
      await expect(page.locator(`#${support.id}`)).toBeFocused();
    }
  }
  await expect(page.locator('script').filter({ hasText: 'pwned' })).toHaveCount(
    0,
  );
  await expect(page.locator('body')).not.toContainText(secretSentinel);
});

test('fails visibly for tampered pagination and keeps back navigation', async ({
  page,
}) => {
  await page.goto(
    `/repositories/${repositoryId}/runs/${reviewRunId}?supportClaim=${supportClaimKey}`,
  );
  const evidenceSupport = page
    .locator(
      '[data-dashboard-collection="summary-supports"][data-summary-support-kind="evidence"]',
    )
    .first();
  await expect(evidenceSupport).toBeVisible();
  await evidenceSupport.getByRole('link').click();
  await expect(
    page.getByRole('heading', { name: 'Evidence detail' }),
  ).toBeVisible();
  const returnHref = await page
    .getByRole('link', { name: 'Back to run evidence' })
    .getAttribute('href');
  expect(returnHref).toBeTruthy();
  const staleReturn = new URL(returnHref, page.url());
  staleReturn.searchParams.set('summarySupports', 'invalid-signed-cursor');
  await page.goto(
    `${staleReturn.pathname}${staleReturn.search}${staleReturn.hash}`,
  );
  await expect(
    page.getByRole('heading', {
      name: 'This evidence page cannot be continued',
    }),
  ).toBeVisible();
  await expect(page.getByRole('main')).toBeFocused();

  await page.goto('/runs');
  const next = page.getByRole('link', {
    name: 'Next runs page',
    exact: true,
  });
  await expect(next).toBeVisible();
  const href = await next.getAttribute('href');
  const url = new URL(href, 'http://127.0.0.1');
  const cursor = url.searchParams.get('cursor');
  url.searchParams.set(
    'cursor',
    `${cursor.slice(0, -1)}${cursor.endsWith('A') ? 'B' : 'A'}`,
  );
  await page.goto(`${url.pathname}${url.search}`);
  await expect(
    page.getByRole('heading', { name: /cannot be continued/i }),
  ).toBeVisible();
  await page.goBack();
  await expect(
    page.getByRole('heading', { name: 'Recorded runs' }),
  ).toBeVisible();

  const freshNext = page.getByRole('link', {
    name: 'Next runs page',
    exact: true,
  });
  await expect(freshNext).toBeVisible();
  const staleHref = await freshNext.getAttribute('href');
  await replaceRunListSourceSnapshot();
  await page.goto(staleHref);
  await expect(
    page.getByRole('heading', { name: /cannot be continued/i }),
  ).toBeVisible();
  await page.goBack();
  await expect(
    page.getByRole('heading', { name: 'Recorded runs' }),
  ).toBeVisible();
});

test('supports keyboard focus and representative responsive widths', async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 760 });
  await page.goto('/runs');
  await expect(page.getByRole('main')).toBeFocused();
  await page.getByRole('link', { name: new RegExp(runId) }).click();
  await expect(page).toHaveURL(
    new RegExp(`/repositories/${repositoryId}/runs/${runId}`),
  );
  await expect(page.getByRole('main')).toBeFocused();
  await page.goBack();
  await expect(
    page.getByRole('heading', { name: 'Recorded runs' }),
  ).toBeVisible();
  await expect(page.getByRole('main')).toBeFocused();
  const skip = page.getByRole('link', { name: 'Skip to evidence' });
  await skip.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('main')).toBeFocused();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByRole('main')).toBeVisible();
});

test('does not distinguish hidden-tenant and nonexistent resource routes', async ({
  page,
}) => {
  const hiddenRepositoryId = process.env.BBX_E2E_HIDDEN_REPOSITORY_ID;
  if (!hiddenRepositoryId)
    throw new Error('The hidden-tenant fixture identity is required.');

  const hidden = await observeGenericNotFound(page, hiddenRepositoryId);
  const missing = await observeGenericNotFound(page, missingRepositoryId);

  expect(hidden.status).toBe(missing.status);
  expect(hidden.headers).toEqual(missing.headers);
  expect(hidden.redirected).toBe(false);
  expect(missing.redirected).toBe(false);
  expect(hidden.visible).toEqual(missing.visible);
  expect(hidden.body).toBe(missing.body);

  for (const privateValue of [
    hiddenRepositoryId,
    repositoryId,
    runId,
    secretSentinel,
    'DASHBOARD_ORGANIZATION_ID',
    'DATABASE_URL',
  ]) {
    expect(hidden.visible.text).not.toContain(privateValue);
    expect(missing.visible.text).not.toContain(privateValue);
  }
});
