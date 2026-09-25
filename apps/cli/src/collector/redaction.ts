import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

import type { ContentCapture } from '@blackbox/contracts';
import { MAX_CONTENT_EXCERPT_LENGTH } from '@blackbox/contracts';

import {
  MAX_LITERAL_BYTES,
  MAX_LITERAL_RULES,
  type CaptureClass,
  type CollectorConfig,
} from './config.js';
import { CollectorError } from './errors.js';

export const REDACTION_RULESET_VERSION = 'collector-redaction-v1';
export const REDACTION_MARKER = '[REDACTED]';
export const REPOSITORY_PLACEHOLDER = '<repository-root>';
export const HOME_PLACEHOLDER = '<user-home>';
const MIN_LITERAL_LENGTH = 8;
const SECRET_ENV_NAME =
  /(?:^|_)(?:API_KEY|AUTH|CREDENTIAL|DATABASE_URL|PASSWORD|PRIVATE_KEY|SECRET|TOKEN)(?:_|$)/i;

interface Match {
  end: number;
  start: number;
}

export interface RedactorOptions {
  collectorCredentials?: readonly string[];
  environment?: NodeJS.ProcessEnv;
  explicitEnvironmentNames?: readonly string[];
  homeDirectory?: string;
  literalFilePath?: string;
  repositoryRoot?: string;
}

export interface RedactionResult {
  matchCount: number;
  text: string;
}

export interface CaptureResult {
  capture: ContentCapture;
  diagnosticCode?: 'capture-bound-reached' | 'collection-failed';
  fullBytes?: Uint8Array;
}

function registerLiteral(target: string[], value: string): boolean {
  if (
    value.length >= MIN_LITERAL_LENGTH &&
    Buffer.byteLength(value) <= MAX_LITERAL_BYTES
  ) {
    target.push(value);
    return true;
  }
  return false;
}

function literalLines(path: string): string[] {
  const bytes = readFileSync(path);
  if (bytes.byteLength > MAX_LITERAL_RULES * (MAX_LITERAL_BYTES + 1)) {
    throw new CollectorError(
      'invalid-config',
      'literal redaction file exceeds its safe bound',
    );
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (cause) {
    throw new CollectorError(
      'invalid-config',
      'literal redaction file is not strict UTF-8',
      { cause },
    );
  }
  return text.split(/\r?\n/u).filter(Boolean);
}

function allIndices(text: string, literal: string): Match[] {
  const matches: Match[] = [];
  let offset = 0;
  while (offset <= text.length - literal.length) {
    const start = text.indexOf(literal, offset);
    if (start < 0) break;
    matches.push({ start, end: start + literal.length });
    offset = start + 1;
  }
  return matches;
}

function regexMatches(
  text: string,
  expression: RegExp,
  valueGroup = 0,
): Match[] {
  const matches: Match[] = [];
  for (const match of text.matchAll(expression)) {
    const value = match[valueGroup];
    if (!value || match.index === undefined) continue;
    const relativeStart = match[0].indexOf(value);
    matches.push({
      start: match.index + relativeStart,
      end: match.index + relativeStart + value.length,
    });
  }
  return matches;
}

function replaceMatches(text: string, matches: Match[]): RedactionResult {
  if (matches.length === 0) return { matchCount: 0, text };
  const sorted = matches.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: Match[] = [];
  for (const match of sorted) {
    const last = merged.at(-1);
    if (last && match.start <= last.end)
      last.end = Math.max(last.end, match.end);
    else merged.push({ ...match });
  }
  let cursor = 0;
  let output = '';
  for (const match of merged) {
    output += text.slice(cursor, match.start) + REDACTION_MARKER;
    cursor = match.end;
  }
  return { matchCount: merged.length, text: output + text.slice(cursor) };
}

function escapeExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function replacePrivatePath(
  text: string,
  configuredPath: string,
  placeholder: string,
): string {
  const normalized = configuredPath.replace(/\\/gu, '/');
  const withoutTrailing = normalized.replace(/\/+$/u, '') || '/';
  const windowsPath = /^[A-Za-z]:\//u.test(withoutTrailing);
  const components = withoutTrailing.split('/').filter(Boolean);
  if (components.length === 0) return text;
  const prefix = withoutTrailing.startsWith('/') ? '[\\\\/]' : '';
  const expression = `${prefix}${components.map(escapeExpression).join('[\\\\/]')}(?![A-Za-z0-9._-])`;
  return text.replace(
    new RegExp(expression, windowsPath ? 'giu' : 'gu'),
    placeholder,
  );
}

export class Redactor {
  readonly literals: readonly string[];
  readonly homeDirectory: string;
  readonly ignoredLiteralCount: number;
  readonly repositoryRoot: string | undefined;

  constructor(options: RedactorOptions = {}) {
    const environment = options.environment ?? process.env;
    const literals: string[] = [];
    let ignoredLiteralCount = 0;
    for (const credential of options.collectorCredentials ?? [])
      if (!registerLiteral(literals, credential)) ignoredLiteralCount += 1;
    const explicit = new Set(options.explicitEnvironmentNames ?? []);
    for (const [name, value] of Object.entries(environment)) {
      if (value && (explicit.has(name) || SECRET_ENV_NAME.test(name)))
        if (!registerLiteral(literals, value)) ignoredLiteralCount += 1;
    }
    if (options.literalFilePath) {
      for (const value of literalLines(options.literalFilePath))
        if (!registerLiteral(literals, value)) ignoredLiteralCount += 1;
    }
    if (literals.length > MAX_LITERAL_RULES) {
      throw new CollectorError(
        'invalid-config',
        'redaction rule count exceeds its safe bound',
      );
    }
    this.literals = [...new Set(literals)].sort();
    this.ignoredLiteralCount = ignoredLiteralCount;
    this.homeDirectory = options.homeDirectory ?? homedir();
    this.repositoryRoot = options.repositoryRoot;
  }

  redact(input: string): RedactionResult {
    let text = input;
    if (this.repositoryRoot)
      text = replacePrivatePath(
        text,
        this.repositoryRoot,
        REPOSITORY_PLACEHOLDER,
      );
    if (this.homeDirectory)
      text = replacePrivatePath(text, this.homeDirectory, HOME_PLACEHOLDER);
    const matches: Match[] = [];
    for (const literal of this.literals)
      matches.push(...allIndices(text, literal));
    matches.push(
      ...regexMatches(
        text,
        /\bAuthorization\s*:\s*(?:Bearer|Basic)\s+([^\s,;]+)/giu,
        1,
      ),
    );
    matches.push(
      ...regexMatches(text, /\b(?:https?|ssh):\/\/([^\s/@:]+:[^\s/@]+)@/giu, 1),
    );
    matches.push(
      ...regexMatches(
        text,
        /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gu,
      ),
    );
    matches.push(
      ...regexMatches(
        text,
        /\b(?:gh[pousr]_[A-Za-z0-9_]{30,}|sk-[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16})\b/gu,
      ),
    );
    matches.push(
      ...regexMatches(
        text,
        /\b(?:xox[baprs]-[A-Za-z0-9-]{20,}|npm_[A-Za-z0-9]{30,}|AIza[A-Za-z0-9_-]{30,})\b/gu,
      ),
    );
    return replaceMatches(text, matches);
  }
}

export function captureText(
  captureClass: CaptureClass,
  input: Uint8Array,
  config: CollectorConfig,
  redactor: Redactor,
): CaptureResult {
  if (!config.captureClasses.has(captureClass))
    return { capture: { state: 'omitted' } };
  if (input.byteLength > config.inputLimitBytes) {
    return {
      capture: { state: 'unavailable', reason: 'collection-failed' },
      diagnosticCode: 'capture-bound-reached',
    };
  }
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(input);
    const redacted = redactor.redact(decoded).text;
    const fullBytes = Buffer.from(redacted, 'utf8');
    const excerpt = redacted.slice(0, MAX_CONTENT_EXCERPT_LENGTH);
    return {
      capture: {
        state: 'captured',
        excerpt,
        truncated: excerpt.length < redacted.length,
        redaction: { applied: true, rulesetVersion: REDACTION_RULESET_VERSION },
      },
      fullBytes,
    };
  } catch {
    return {
      capture: { state: 'unavailable', reason: 'collection-failed' },
      diagnosticCode: 'collection-failed',
    };
  }
}
