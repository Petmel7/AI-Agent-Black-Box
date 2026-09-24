import { Readable } from 'node:stream';

import {
  ArtifactObjectMissingError,
  type ArtifactStoragePort,
} from './artifact-service.js';

export interface SupabaseStorageConfig {
  url: string | undefined;
  serviceRoleKey: string | undefined;
  bucket: string | undefined;
  fetch?: typeof fetch;
  now?: () => Date;
}

function required(value: string | undefined, label: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error(`Missing ${label} storage configuration.`);
  return trimmed;
}

function path(value: string): string {
  return value.split('/').map(encodeURIComponent).join('/');
}

function metadata(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64');
}

function signedTokenExpiry(token: string, now: Date): Date {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1])
    throw new Error('Storage capability token was invalid.');
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    throw new Error('Storage capability token was invalid.');
  }
  const expires =
    typeof payload === 'object' && payload !== null
      ? (payload as { exp?: unknown }).exp
      : undefined;
  if (
    !Number.isSafeInteger(expires) ||
    (expires as number) <= 0 ||
    (expires as number) > 8_640_000_000
  )
    throw new Error('Storage capability expiry was invalid.');
  const result = new Date((expires as number) * 1000);
  if (result <= now)
    throw new Error('Storage capability token was already expired.');
  return result;
}

/** Lazy Supabase Storage adapter. Construction validates but performs no I/O. */
export class SupabaseArtifactStorage implements ArtifactStoragePort {
  private readonly baseUrl: string;
  private readonly serviceRoleKey: string;
  private readonly bucket: string;
  private readonly request: typeof fetch;
  private readonly now: () => Date;

  constructor(config: SupabaseStorageConfig) {
    const rawUrl = required(config.url, 'URL');
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new Error('Storage URL configuration is invalid.');
    }
    if (url.protocol !== 'https:' && url.hostname !== 'localhost')
      throw new Error('Storage URL must use HTTPS.');
    this.baseUrl = url.toString().replace(/\/$/, '');
    this.serviceRoleKey = required(config.serviceRoleKey, 'service-role key');
    this.bucket = required(config.bucket, 'bucket');
    this.request = config.fetch ?? fetch;
    this.now = config.now ?? (() => new Date());
  }

  private headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.serviceRoleKey}`,
      apikey: this.serviceRoleKey,
    };
  }

  async issueUploadCapability(input: {
    objectKey: string;
    mediaType: string;
    byteLength: bigint;
  }) {
    const signedResponse = await this.request(
      `${this.baseUrl}/storage/v1/object/upload/sign/${path(this.bucket)}/${path(input.objectKey)}`,
      {
        method: 'POST',
        redirect: 'error',
        headers: { ...this.headers(), 'content-type': 'application/json' },
        body: JSON.stringify({}),
      },
    );
    if (!signedResponse.ok)
      throw new Error('Storage capability issuance failed.');
    const payload = (await signedResponse.json()) as Record<string, unknown>;
    if (typeof payload.token !== 'string' || payload.token.length === 0)
      throw new Error('Storage capability response was invalid.');
    const expiresAt = signedTokenExpiry(payload.token, this.now());
    const tusUrl = `${this.baseUrl}/storage/v1/upload/resumable/sign`;
    const tusResponse = await this.request(tusUrl, {
      method: 'POST',
      redirect: 'error',
      headers: {
        'tus-resumable': '1.0.0',
        'upload-length': input.byteLength.toString(),
        'upload-metadata': [
          `bucketName ${metadata(this.bucket)}`,
          `objectName ${metadata(input.objectKey)}`,
          `contentType ${metadata(input.mediaType)}`,
        ].join(','),
        'x-signature': payload.token,
        'x-upsert': 'false',
      },
    });
    if (tusResponse.status !== 201)
      throw new Error('Storage resumable session creation failed.');
    const location = tusResponse.headers.get('location')?.trim();
    if (!location)
      throw new Error('Storage resumable session response was invalid.');
    let endpoint: URL;
    try {
      endpoint = new URL(location, tusUrl);
    } catch {
      throw new Error('Storage resumable session location was invalid.');
    }
    if (
      endpoint.origin !== new URL(this.baseUrl).origin ||
      [
        this.bucket,
        encodeURIComponent(this.bucket),
        input.objectKey,
        encodeURIComponent(input.objectKey),
      ].some((secret) => location.includes(secret))
    )
      throw new Error('Storage resumable session location was invalid.');
    return {
      protocol: 'tus' as const,
      endpoint: endpoint.toString(),
      capabilityToken: payload.token,
      expiresAt,
      requiredChunkSize: 6 * 1024 * 1024,
    };
  }

  async openReadable(objectKey: string): Promise<Readable> {
    const response = await this.request(
      `${this.baseUrl}/storage/v1/object/authenticated/${path(this.bucket)}/${path(objectKey)}`,
      { headers: this.headers(), redirect: 'error' },
    );
    if (response.status === 404) throw new ArtifactObjectMissingError();
    if (!response.ok || !response.body)
      throw new Error('Storage object read failed.');
    return Readable.fromWeb(response.body);
  }

  async deleteObject(objectKey: string): Promise<void> {
    const response = await this.request(
      `${this.baseUrl}/storage/v1/object/${path(this.bucket)}/${path(objectKey)}`,
      { method: 'DELETE', headers: this.headers(), redirect: 'error' },
    );
    if (!response.ok && response.status !== 404)
      throw new Error('Storage object deletion failed.');
  }
}

export function createEnvironmentArtifactStorage(
  environment: NodeJS.ProcessEnv = process.env,
): SupabaseArtifactStorage {
  return new SupabaseArtifactStorage({
    url: environment.SUPABASE_URL,
    serviceRoleKey: environment.SUPABASE_SERVICE_ROLE_KEY,
    bucket: environment.ARTIFACT_STORAGE_BUCKET,
  });
}
