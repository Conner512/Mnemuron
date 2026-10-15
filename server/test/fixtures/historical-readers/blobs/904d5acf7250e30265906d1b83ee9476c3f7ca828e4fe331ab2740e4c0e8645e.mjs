export class ValidationError extends Error {
  constructor(message, errorCode = "INVALID_PAYLOAD") {
    super(message);
    this.name = "ValidationError";
    this.statusCode = 400;
    this.errorCode = errorCode;
  }
}

export class AuthenticationError extends Error {
  constructor(message = "Invalid or revoked API credential.") {
    super(message);
    this.name = "AuthenticationError";
    this.statusCode = 401;
    this.errorCode = "INVALID_CREDENTIAL";
  }
}

export class AuthorizationError extends Error {
  constructor(scope) {
    super(`Credential lacks required scope: ${scope}.`);
    this.name = "AuthorizationError";
    this.statusCode = 403;
    this.errorCode = "INSUFFICIENT_SCOPE";
  }
}

export class NotFoundError extends Error {
  constructor(message, errorCode = "NOT_FOUND") {
    super(message);
    this.name = "NotFoundError";
    this.statusCode = 404;
    this.errorCode = errorCode;
  }
}

export class ConflictError extends Error {
  constructor(message, errorCode = "LIFECYCLE_CONFLICT") {
    super(message);
    this.name = "ConflictError";
    this.statusCode = 409;
    this.errorCode = errorCode;
  }
}

// Deterministic request outcomes (validation, authentication, authorization, not found, conflicts such as
// PROJECT_DELETED). Retrieval fallbacks must re-throw these instead of reporting them as provider degradation.
export const isDeterministicReadError = (error) => [ValidationError, AuthenticationError, AuthorizationError, NotFoundError, ConflictError]
  .some((type) => error instanceof type);
