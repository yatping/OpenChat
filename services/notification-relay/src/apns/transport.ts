import type { ApnsRequest, ApnsResponse, ApnsTransport } from '@openchat/notification-protocol';

async function readReason(response: Response): Promise<{ reason?: string; timestamp?: number }> {
  const text = await response.text();
  if (!text) return {};
  try {
    const body = JSON.parse(text) as { reason?: unknown; timestamp?: unknown };
    return { ...(typeof body.reason === 'string' ? { reason: body.reason } : {}), ...(typeof body.timestamp === 'number' ? { timestamp: body.timestamp } : {}) };
  } catch {
    return {};
  }
}

/**
 * The production default. It relies on Cloudflare's proxy speaking HTTP/2 to APNs, which is observed and not
 * documented (ADR-0006). A network failure rejects, and the caller treats that as retryable.
 */
export class WorkersFetchTransport implements ApnsTransport {
  constructor(private readonly fetcher: typeof fetch = (input, init) => fetch(input, init)) {}

  async send(request: ApnsRequest): Promise<ApnsResponse> {
    const response = await this.fetcher(`https://${request.host}/3/device/${request.token}`, { method: 'POST', headers: request.headers, body: request.body });
    const apnsId = response.headers.get('apns-id');
    return { status: response.status, ...(apnsId ? { apnsId } : {}), ...(await readReason(response)) };
  }
}

/** Tests and local development, because local `workerd` has no HTTP/2 client. Plays back the answers it is given. */
export class MockApnsTransport implements ApnsTransport {
  readonly requests: ApnsRequest[] = [];

  constructor(private readonly answers: (ApnsResponse | Error)[] = [{ status: 200 }]) {}

  async send(request: ApnsRequest): Promise<ApnsResponse> {
    this.requests.push(request);
    const answer = this.answers.length > 1 ? this.answers.shift()! : this.answers[0]!;
    if (answer instanceof Error) throw answer;
    return answer;
  }
}
