/** Errors deliberately omit response bodies, headers, credentials and underlying causes. */
export class AppError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "AppError";
  }
}

export class HttpError extends AppError {
  constructor(public readonly status: number, public readonly retryAfterMs: number | null) {
    super("http_error", "The service rejected the request.");
    this.name = "HttpError";
  }
}

export class TokenExpiredError extends AppError {
  constructor() {
    super("token_expired", "The credential has expired. Open Pi to refresh its credentials.");
    this.name = "TokenExpiredError";
  }
}

export function invalidResponse(): never {
  throw new AppError("invalid_response", "The service returned an invalid response.");
}
