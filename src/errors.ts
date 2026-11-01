// Errors the HTTP layer turns into status codes.
export class HttpError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 413 | 422 | 502 | 503,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const notFound = (what: string) => new HttpError(404, 'NOT_FOUND', `${what} not found`);
export const invalid = (message: string) => new HttpError(400, 'INVALID_INPUT', message);
export const conflict = (code: string, message: string) => new HttpError(409, code, message);
