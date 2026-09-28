import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Readable } from 'node:stream';

import { MAX_RESPONSE_BYTES, type DeliveryConfig } from './delivery-config.js';

export type TransportFailure =
  | 'connect-timeout'
  | 'network-failed'
  | 'overall-timeout'
  | 'request-timeout'
  | 'response-invalid'
  | 'response-too-large';

export class TransportError extends Error {
  constructor(readonly failure: TransportFailure) {
    super('remote request failed safely');
    this.name = 'TransportError';
  }
}

export interface SafeHttpRequest {
  body?: Readable | string | Uint8Array;
  contentLength?: number;
  headers?: Readonly<Record<string, string>>;
  method: 'GET' | 'HEAD' | 'PATCH' | 'POST';
  url: URL;
}

export interface SafeHttpResponse {
  body: string;
  headers: Readonly<Record<string, string>>;
  status: number;
}

function headerRecord(
  headers: Readonly<Record<string, string | string[] | undefined>>,
): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === 'string') result[name.toLowerCase()] = value;
    else if (value) result[name.toLowerCase()] = value.join(', ');
  }
  return Object.freeze(result);
}

export class SafeHttpClient {
  constructor(private readonly config: DeliveryConfig) {}

  request(
    input: SafeHttpRequest,
    operationBudgetMs: number,
  ): Promise<SafeHttpResponse> {
    if (!Number.isFinite(operationBudgetMs) || operationBudgetMs <= 0)
      return Promise.reject(new TransportError('overall-timeout'));
    const effectiveOverallTimeoutMs = Math.max(
      1,
      Math.floor(Math.min(this.config.overallTimeoutMs, operationBudgetMs)),
    );
    return new Promise((resolve, reject) => {
      let settled = false;
      let connectTimer: NodeJS.Timeout | undefined;
      const streamingBody =
        input.body !== undefined &&
        typeof input.body !== 'string' &&
        !(input.body instanceof Uint8Array)
          ? input.body
          : undefined;
      const finish = (
        outcome: { response: SafeHttpResponse } | { error: TransportError },
      ) => {
        if (settled) return;
        settled = true;
        if (connectTimer) clearTimeout(connectTimer);
        if (overallTimer) clearTimeout(overallTimer);
        if ('error' in outcome) {
          streamingBody?.destroy();
          reject(outcome.error);
        } else resolve(outcome.response);
      };
      const request = (
        input.url.protocol === 'https:' ? httpsRequest : httpRequest
      )(
        input.url,
        {
          headers: {
            ...input.headers,
            ...(input.contentLength === undefined
              ? {}
              : { 'content-length': String(input.contentLength) }),
          },
          method: input.method,
        },
        (response) => {
          if (connectTimer) clearTimeout(connectTimer);
          const chunks: Buffer[] = [];
          let bytes = 0;
          response.on('data', (chunk: Buffer) => {
            bytes += chunk.byteLength;
            if (bytes > MAX_RESPONSE_BYTES) {
              response.destroy();
              finish({ error: new TransportError('response-too-large') });
              return;
            }
            chunks.push(Buffer.from(chunk));
          });
          response.on('end', () => {
            try {
              finish({
                response: {
                  body: new TextDecoder('utf-8', { fatal: true }).decode(
                    Buffer.concat(chunks),
                  ),
                  headers: headerRecord(response.headers),
                  status: response.statusCode ?? 0,
                },
              });
            } catch {
              finish({ error: new TransportError('response-invalid') });
            }
          });
          response.on('error', () =>
            finish({ error: new TransportError('network-failed') }),
          );
        },
      );
      const overallTimer = setTimeout(() => {
        request.destroy();
        finish({ error: new TransportError('overall-timeout') });
      }, effectiveOverallTimeoutMs);
      request.setTimeout(
        Math.min(this.config.requestTimeoutMs, effectiveOverallTimeoutMs),
        () => {
          request.destroy();
          finish({ error: new TransportError('request-timeout') });
        },
      );
      request.on('socket', (socket) => {
        if (!socket.connecting) return;
        connectTimer = setTimeout(
          () => {
            request.destroy();
            finish({ error: new TransportError('connect-timeout') });
          },
          Math.min(this.config.connectTimeoutMs, effectiveOverallTimeoutMs),
        );
        const connected = () => {
          if (connectTimer) clearTimeout(connectTimer);
        };
        socket.once(
          input.url.protocol === 'https:' ? 'secureConnect' : 'connect',
          connected,
        );
      });
      request.on('error', () =>
        finish({ error: new TransportError('network-failed') }),
      );
      if (input.body === undefined) request.end();
      else if (
        typeof input.body === 'string' ||
        input.body instanceof Uint8Array
      )
        request.end(input.body);
      else {
        input.body.on('error', () => request.destroy());
        input.body.pipe(request);
      }
    });
  }
}

export function hasJsonMediaType(value: string | undefined): boolean {
  return /^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(value ?? '');
}
