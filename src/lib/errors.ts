/** Application error taxonomy. Each carries an HTTP status so route handlers stay thin. */
export class AppError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 'VALIDATION_ERROR', 422, details);
  }
}

export class NotFoundError extends AppError {
  constructor(entity: string, id?: string) {
    super(id ? `${entity} ${id} not found` : `${entity} not found`, 'NOT_FOUND', 404);
  }
}

export class AuthenticationError extends AppError {
  constructor(message = 'Authentication required') {
    super(message, 'UNAUTHENTICATED', 401);
  }
}

export class AuthorizationError extends AppError {
  constructor(message = 'You do not have permission to perform this action') {
    super(message, 'FORBIDDEN', 403);
  }
}

/** Raised when a posting would land in a closed or locked accounting period. */
export class ClosedPeriodError extends AppError {
  constructor(entryDate: Date, status: string) {
    super(
      `Cannot post to ${entryDate.toISOString().slice(0, 10)}: the accounting period is ${status}`,
      'PERIOD_CLOSED',
      409,
    );
  }
}

/** Raised when debits do not equal credits, or the entry is otherwise malformed. */
export class UnbalancedEntryError extends AppError {
  constructor(debits: bigint, credits: bigint) {
    super(
      `Journal entry is out of balance: debits ${debits} <> credits ${credits}`,
      'UNBALANCED_ENTRY',
      422,
      { debits: debits.toString(), credits: credits.toString() },
    );
  }
}

/** Raised on any attempt to alter a posted entry. */
export class ImmutableLedgerError extends AppError {
  constructor(entryNo: string) {
    super(
      `Journal entry ${entryNo} is posted and cannot be changed. Post a reversing entry instead.`,
      'LEDGER_IMMUTABLE',
      409,
    );
  }
}
