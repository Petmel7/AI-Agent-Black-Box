import { describe, expect, it } from 'vitest';

import { runCli, validateCodexArguments } from './cli.js';

describe('Codex command argument validation', () => {
  it.each([
    ['no arguments', []],
    ['ordinary prompt', ['prompt']],
    ['stdin prompt marker', ['-']],
    ['reserved words inside prompt text', ['please review then resume']],
    ['review after end-of-options delimiter', ['--', 'review']],
    ['resume after end-of-options delimiter', ['--', 'resume']],
    ['profile named review', ['--profile', 'review', 'prompt']],
    ['model named resume', ['--model', 'resume', 'prompt']],
    ['short profile option', ['-p', 'review', 'prompt']],
    ['short model option', ['-m', 'resume', 'prompt']],
    ['short config option', ['-c', 'review', 'prompt']],
    ['short approval option', ['-a', 'resume', 'prompt']],
    ['short sandbox option', ['-s', 'review', 'prompt']],
    ['short image option', ['-i', 'resume', 'prompt']],
    ['short output option', ['-o', 'review', 'prompt']],
    ['attached short profile value', ['-preview', 'prompt']],
    ['attached short model value', ['-mresume', 'prompt']],
    ['long config option', ['--config', 'resume', 'prompt']],
    ['output schema named review', ['--output-schema', 'review', 'prompt']],
    [
      'output last message named resume',
      ['--output-last-message', 'resume', 'prompt'],
    ],
    ['profile equals form', ['--profile=review', 'prompt']],
    ['model equals form', ['--model=resume', 'prompt']],
    ['config equals form', ['--config=review', 'prompt']],
    ['output schema equals form', ['--output-schema=resume', 'prompt']],
    [
      'output last message equals form',
      ['--output-last-message=review', 'prompt'],
    ],
    ['options after prompt', ['prompt', '--profile', 'review']],
    ['supported boolean flags', ['--ephemeral', '--search', 'prompt']],
  ])('accepts $0', (_name, args) => {
    expect(validateCodexArguments(args)).toBe(true);
  });

  it.each([
    ['actual resume subcommand', ['resume']],
    ['actual review subcommand', ['review']],
    ['resume after a flag', ['--ephemeral', 'resume']],
    ['review after a value option', ['--model', 'gpt-5', 'review']],
    ['duplicate JSON mode', ['--json']],
    ['duplicate JSON mode with value', ['--json=true']],
    ['duplicate JSON mode after prompt', ['prompt', '--json']],
    ['long root change', ['--cd', 'elsewhere']],
    ['long root change equals form', ['--cd=elsewhere']],
    ['short root change', ['-C', 'elsewhere']],
    ['attached short root change', ['-Celsewhere']],
    ['additional root', ['--add-dir', 'elsewhere']],
    ['additional root equals form', ['--add-dir=elsewhere']],
    ['missing long value', ['--profile']],
    ['missing short value', ['-m']],
    ['empty long equals value', ['--model=']],
    ['empty attached short value', ['-p=']],
    ['option where value is required', ['--config', '--ephemeral']],
    ['short option where value is required', ['-c', '--search']],
    ['unknown long option', ['--future-option']],
    ['unknown short option', ['-x']],
    ['value supplied to a flag', ['--ephemeral=true']],
    ['multiple positional prompts', ['first', 'review']],
    ['content after prompt delimiter', ['prompt', '--', 'review']],
    ['empty argument', ['']],
    ['argument containing NUL', ['prompt\0content']],
  ])('rejects $0', (_name, args) => {
    expect(validateCodexArguments(args)).toBe(false);
  });

  it('rejects an excessive argument count', () => {
    expect(
      validateCodexArguments(Array.from({ length: 257 }, () => '--ephemeral')),
    ).toBe(false);
  });

  it('rejects an excessive individual or aggregate argument size', () => {
    expect(validateCodexArguments(['x'.repeat(32_769)])).toBe(false);
    expect(
      validateCodexArguments(
        Array.from({ length: 9 }, (_, index) => [
          '--config',
          `key${index}=${'x'.repeat(31_990)}`,
        ]).flat(),
      ),
    ).toBe(false);
  });

  it('rejects prohibited arguments at the CLI boundary before composition', async () => {
    const errors: string[] = [];
    const result = await runCli(
      ['codex', '--', '--json'],
      {
        error: (message) => errors.push(message),
        output: () => undefined,
      },
      { env: { BLACKBOX_SPOOL_DIR: 'must-not-be-read' } },
    );

    expect(result).toBe(1);
    expect(errors).toEqual(['Invalid codex arguments']);
  });
});
