export type CollectorErrorCode =
  | 'artifact-corrupt'
  | 'artifact-missing'
  | 'busy'
  | 'collection-failed'
  | 'invalid-config'
  | 'invalid-owner'
  | 'lease-lost'
  | 'newer-schema'
  | 'quota-exceeded'
  | 'spool-corrupt';

export class CollectorError extends Error {
  constructor(
    readonly code: CollectorErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'CollectorError';
  }
}
