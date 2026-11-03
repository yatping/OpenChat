/** RFC 9457 problem details. See docs/api/conventions.md. */
export interface Problem {
  type: string;
  title: string;
  status: number;
  code: string;
  requestId: string;
  details?: Record<string, unknown>;
}

export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;

  constructor(status: number, code: string, title: string, details?: Record<string, unknown>) {
    super(title);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const notFound = (title = 'Not found'): AppError => new AppError(404, 'not_found', title);

export const versionConflict = (currentVersion: number): AppError =>
  new AppError(409, 'version_conflict', 'The resource was changed by someone else', { currentVersion });

export function toProblem(error: unknown, requestId: string): Problem {
  if (error instanceof AppError) {
    return {
      type: `urn:openchat:error:${error.code}`,
      title: error.message,
      status: error.status,
      code: error.code,
      requestId,
      ...(error.details ? { details: error.details } : {}),
    };
  }
  // Never echo an unexpected error's message: it may contain data that must not leave the server.
  return {
    type: 'urn:openchat:error:internal',
    title: 'Internal error',
    status: 500,
    code: 'internal',
    requestId,
  };
}
