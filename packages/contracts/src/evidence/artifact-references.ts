import type { ArtifactReference } from './artifact.js';
import type { ContentCapture } from './content.js';
import type { EvidenceEvent } from './events.js';

export interface LocatedArtifactReference {
  reference: ArtifactReference;
  jsonPointer: string;
}

function capturedArtifact(
  capture: ContentCapture,
  jsonPointer: string,
): LocatedArtifactReference[] {
  return capture.state === 'captured' && capture.artifact
    ? [{ reference: capture.artifact, jsonPointer }]
    : [];
}

function assertNever(value: never): never {
  throw new Error(`Unsupported evidence event kind: ${String(value)}`);
}

/** Extracts every v1 artifact reference and its RFC 6901 location. */
export function extractArtifactReferences(
  event: EvidenceEvent,
): LocatedArtifactReference[] {
  switch (event.kind) {
    case 'run.started':
      return event.payload.taskDescription
        ? capturedArtifact(
            event.payload.taskDescription,
            '/payload/taskDescription/artifact',
          )
        : [];
    case 'run.finished':
    case 'usage.observed':
      return [];
    case 'tool.call.started':
      return capturedArtifact(event.payload.input, '/payload/input/artifact');
    case 'tool.call.finished':
      return capturedArtifact(event.payload.output, '/payload/output/artifact');
    case 'command.started':
      return [
        ...capturedArtifact(event.payload.command, '/payload/command/artifact'),
        ...capturedArtifact(
          event.payload.workingDirectory,
          '/payload/workingDirectory/artifact',
        ),
      ];
    case 'command.finished':
      return [
        ...capturedArtifact(event.payload.stdout, '/payload/stdout/artifact'),
        ...capturedArtifact(event.payload.stderr, '/payload/stderr/artifact'),
      ];
    case 'test.run.finished':
      return event.payload.reportArtifact
        ? [
            {
              reference: event.payload.reportArtifact,
              jsonPointer: '/payload/reportArtifact',
            },
          ]
        : [];
    case 'git.snapshot.captured':
      return event.payload.statusArtifact
        ? [
            {
              reference: event.payload.statusArtifact,
              jsonPointer: '/payload/statusArtifact',
            },
          ]
        : [];
    case 'git.diff.captured':
      return [
        {
          reference: event.payload.diffArtifact,
          jsonPointer: '/payload/diffArtifact',
        },
        {
          reference: event.payload.fileListArtifact,
          jsonPointer: '/payload/fileListArtifact',
        },
      ];
    case 'error.observed':
      return capturedArtifact(
        event.payload.message,
        '/payload/message/artifact',
      );
    default:
      return assertNever(event);
  }
}
