import { z } from 'zod';

import { UuidSchema } from './evidence/primitives.js';

export const GIT_FILE_LIST_MAX_BYTES = 20_000_000;
export const GIT_FILE_LIST_MAX_ENTRIES = 10_000;
export const GIT_FILE_LIST_MAX_PATH_LENGTH = 32_768;

const OpaqueEntryIdSchema = z.string().regex(/^[a-f0-9]{64}$/);
const DisplayPathSchema = z.string().min(1).max(GIT_FILE_LIST_MAX_PATH_LENGTH);
const SafeReasonSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9._-]*$/);
const GitStatusSchema = z.enum(['.', '?', 'M', 'A', 'D', 'R', 'C', 'U', 'T']);
const GitSubmoduleSchema = z.string().regex(/^(?:N\.\.\.|S[.C][.M][.U])$/);
const UnavailableReasonSchema = z.enum([
  'entry-size-limit',
  'read-failed',
  'read-race',
  'unsupported-file-type',
]);

const AmbiguitySchema = z
  .object({
    displayAmbiguous: z.literal(true).optional(),
    displayReason: z.literal('redaction-collision').optional(),
  })
  .strict()
  .refine(
    (value) =>
      (value.displayAmbiguous === true) ===
      (value.displayReason === 'redaction-collision'),
    { message: 'Display ambiguity fields must occur together.' },
  );

export const GitFileStateV1Schema = z
  .object({
    entryId: OpaqueEntryIdSchema,
    path: DisplayPathSchema,
    originalPath: DisplayPathSchema.optional(),
    kind: z.enum(['ordinary', 'rename-or-copy', 'unmerged', 'untracked']),
    indexStatus: GitStatusSchema,
    worktreeStatus: GitStatusSchema,
    submodule: GitSubmoduleSchema,
    modeHead: z
      .string()
      .regex(/^[0-7]{6}$/)
      .optional(),
    modeIndex: z
      .string()
      .regex(/^[0-7]{6}$/)
      .optional(),
    modeWorktree: z
      .string()
      .regex(/^[0-7]{6}$/)
      .optional(),
    binary: z.literal(true).optional(),
    unavailableReason: UnavailableReasonSchema.optional(),
    displayAmbiguous: z.literal(true).optional(),
    displayReason: z.literal('redaction-collision').optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const ambiguity = AmbiguitySchema.safeParse({
      displayAmbiguous: value.displayAmbiguous,
      displayReason: value.displayReason,
    });
    if (!ambiguity.success)
      context.addIssue({
        code: 'custom',
        message: 'Invalid display ambiguity metadata.',
      });
    if (
      (value.kind === 'untracked' &&
        (value.indexStatus !== '?' || value.worktreeStatus !== '?')) ||
      (value.kind !== 'untracked' &&
        (value.indexStatus === '?' || value.worktreeStatus === '?'))
    )
      context.addIssue({
        code: 'custom',
        message: 'Git status is inconsistent with the entry kind.',
      });
    if ((value.kind === 'rename-or-copy') !== Boolean(value.originalPath))
      context.addIssue({
        code: 'custom',
        message: 'Only rename-or-copy entries require an original path.',
      });
    if (value.binary && value.unavailableReason)
      context.addIssue({
        code: 'custom',
        message: 'Binary and unavailable metadata are mutually exclusive.',
      });
  });

function compareUtf8(left: string, right: string): number {
  const encoder = new TextEncoder();
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    if (a[index] !== b[index]) return a[index]! - b[index]!;
  }
  return a.length - b.length;
}

export const GitFileEntryV1Schema = z
  .object({
    entryId: OpaqueEntryIdSchema,
    path: DisplayPathSchema,
    displayAmbiguous: z.literal(true).optional(),
    displayReason: z.literal('redaction-collision').optional(),
    attribution: z.enum([
      'pre-existing',
      'observed-during-run',
      'mixed-or-uncertain',
      'unavailable',
    ]),
    reason: SafeReasonSchema.optional(),
    before: GitFileStateV1Schema.nullable(),
    after: GitFileStateV1Schema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.before && !value.after)
      context.addIssue({
        code: 'custom',
        message: 'A file transition requires an endpoint.',
      });
    if (value.entryId !== (value.after ?? value.before)?.entryId)
      context.addIssue({
        code: 'custom',
        message: 'Current entry identity does not match its endpoint.',
      });
    if (value.path !== (value.after ?? value.before)?.path)
      context.addIssue({
        code: 'custom',
        message: 'Current display path does not match its endpoint.',
      });
    if (
      (value.displayAmbiguous === true) !==
      (value.displayReason === 'redaction-collision')
    )
      context.addIssue({
        code: 'custom',
        message: 'Invalid display ambiguity metadata.',
      });
    if (value.attribution === 'unavailable' && !value.reason)
      context.addIssue({
        code: 'custom',
        message: 'Unavailable attribution requires a safe reason.',
      });
    const unavailableReason =
      value.before?.unavailableReason ?? value.after?.unavailableReason;
    if ((value.attribution === 'unavailable') !== Boolean(unavailableReason))
      context.addIssue({
        code: 'custom',
        message:
          'Unavailable attribution must match unavailable endpoint evidence.',
      });
    if (
      value.attribution === 'unavailable' &&
      value.reason !== unavailableReason
    )
      context.addIssue({
        code: 'custom',
        message: 'Unavailable attribution reason must match its endpoint.',
      });
    const current = value.after ?? value.before!;
    if (
      value.displayAmbiguous !== current.displayAmbiguous ||
      value.displayReason !== current.displayReason
    )
      context.addIssue({
        code: 'custom',
        message: 'Current display ambiguity must match its endpoint.',
      });
  });

export const GitFileListV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    diffId: UuidSchema,
    fromSnapshotId: UuidSchema,
    toSnapshotId: UuidSchema,
    attributionIsTemporalNotCausal: z.literal(true),
    files: z.array(GitFileEntryV1Schema).max(GIT_FILE_LIST_MAX_ENTRIES),
  })
  .strict()
  .superRefine((value, context) => {
    const identities = new Set<string>();
    let priorPath: string | undefined;
    for (const [index, file] of value.files.entries()) {
      if (identities.has(file.entryId))
        context.addIssue({
          code: 'custom',
          path: ['files', index, 'entryId'],
          message: 'Duplicate file entry identity.',
        });
      identities.add(file.entryId);
      if (priorPath !== undefined && compareUtf8(priorPath, file.path) > 0)
        context.addIssue({
          code: 'custom',
          path: ['files', index, 'path'],
          message: 'File entries are not deterministically ordered.',
        });
      priorPath = file.path;
    }
  });

export type GitFileListV1 = z.infer<typeof GitFileListV1Schema>;
export type GitFileEntryV1 = z.infer<typeof GitFileEntryV1Schema>;
