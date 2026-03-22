/**
 * CSA.IBKR — Error Handler (Engine Layer)
 * 
 * Centralized error classification and handling.
 * Maps gateway errors to actionable categories.
 */

import logger from './logger.js';
import eventBus from './event-bus.js';

/**
 * Error categories for gateway operations
 */
const ErrorCategory = Object.freeze({
  NETWORK: 'NETWORK',         // Fetch failed, DNS, timeout
  AUTH: 'AUTH',                // 401, session expired, login required
  FORBIDDEN: 'FORBIDDEN',     // 403, IP blocked, permissions
  NOT_FOUND: 'NOT_FOUND',     // 404, invalid endpoint
  RATE_LIMIT: 'RATE_LIMIT',   // 429, too many requests
  SERVER: 'SERVER',            // 5xx from IBKR
  CORS: 'CORS',               // CORS policy violation
  WEBSOCKET: 'WEBSOCKET',     // WS connection errors
  CONFIG: 'CONFIG',            // Config validation errors
  UNKNOWN: 'UNKNOWN'          // Unclassified
});

/**
 * Custom error class for gateway operations
 */
class GatewayError extends Error {
  /**
   * @param {string} message - Human readable error message
   * @param {string} category - ErrorCategory value
   * @param {object} [context] - Additional context (endpoint, status, etc.)
   */
  constructor(message, category = ErrorCategory.UNKNOWN, context = {}) {
    super(message);
    this.name = 'GatewayError';
    this.category = category;
    this.context = context;
    this.timestamp = Date.now();
    this.recoverable = this.#isRecoverable(category);
  }

  #isRecoverable(category) {
    return [
      ErrorCategory.NETWORK,
      ErrorCategory.RATE_LIMIT,
      ErrorCategory.SERVER,
      ErrorCategory.WEBSOCKET
    ].includes(category);
  }
}

const log = logger.child('ErrorHandler');

/**
 * Classify a fetch Response or Error into a GatewayError.
 * @param {Error|Response} errorOrResponse - The error or HTTP response
 * @param {string} [endpoint] - The API endpoint being called
 * @returns {GatewayError}
 */
function classifyError(errorOrResponse, endpoint = '') {
  // Network/fetch errors
  if (errorOrResponse instanceof TypeError) {
    // TypeError from fetch usually means network failure or CORS
    const message = errorOrResponse.message.toLowerCase();
    if (message.includes('cors') || message.includes('opaque')) {
      return new GatewayError(
        `CORS policy blocked request to ${endpoint}`,
        ErrorCategory.CORS,
        { endpoint, originalError: errorOrResponse.message }
      );
    }
    return new GatewayError(
      `Network error on ${endpoint}: ${errorOrResponse.message}`,
      ErrorCategory.NETWORK,
      { endpoint, originalError: errorOrResponse.message }
    );
  }

  // HTTP Response errors
  if (errorOrResponse instanceof Response) {
    const status = errorOrResponse.status;
    const context = { endpoint, status, statusText: errorOrResponse.statusText };

    if (status === 0) {
      // Opaque response = CORS blocked
      return new GatewayError('CORS: Opaque response received', ErrorCategory.CORS, context);
    }
    if (status === 401) {
      return new GatewayError('Authentication required — session expired or invalid', ErrorCategory.AUTH, context);
    }
    if (status === 403) {
      return new GatewayError('Forbidden — insufficient permissions or IP blocked', ErrorCategory.FORBIDDEN, context);
    }
    if (status === 404) {
      return new GatewayError(`Endpoint not found: ${endpoint}`, ErrorCategory.NOT_FOUND, context);
    }
    if (status === 429) {
      return new GatewayError('Rate limited — too many requests', ErrorCategory.RATE_LIMIT, context);
    }
    if (status >= 500) {
      return new GatewayError(`IBKR server error (${status})`, ErrorCategory.SERVER, context);
    }

    return new GatewayError(`HTTP ${status}: ${errorOrResponse.statusText}`, ErrorCategory.UNKNOWN, context);
  }

  // Generic Error
  if (errorOrResponse instanceof Error) {
    return new GatewayError(
      errorOrResponse.message,
      ErrorCategory.UNKNOWN,
      { endpoint, originalError: errorOrResponse.message }
    );
  }

  return new GatewayError('Unknown error', ErrorCategory.UNKNOWN, { endpoint });
}

/**
 * Handle a gateway error: log, emit event, and optionally retry.
 * @param {GatewayError} error
 * @param {object} [options]
 * @param {boolean} [options.silent=false] - Don't emit events
 */
function handleError(error, options = {}) {
  // Log based on severity
  if (error.category === ErrorCategory.AUTH) {
    log.warn(`[${error.category}] ${error.message}`);
    if (!options.silent) {
      eventBus.emit('session:expired', { error: error.message }, true);
    }
  } else if (error.category === ErrorCategory.CORS) {
    log.error(`[${error.category}] ${error.message} — This likely requires a CORS proxy.`);
  } else if (error.recoverable) {
    log.warn(`[${error.category}] ${error.message} (recoverable)`);
  } else {
    log.error(`[${error.category}] ${error.message}`, error.context);
  }

  // Emit error event
  if (!options.silent) {
    eventBus.emit('system:error', {
      category: error.category,
      message: error.message,
      recoverable: error.recoverable,
      context: error.context
    });
  }
}

/**
 * Retry a function with exponential backoff.
 * @param {Function} fn - Async function to retry
 * @param {object} [options]
 * @param {number} [options.maxRetries=3]
 * @param {number} [options.baseDelay=1000] - Base delay in ms
 * @param {number} [options.maxDelay=30000] - Max delay in ms
 * @param {Function} [options.shouldRetry] - Predicate (error) => boolean
 * @returns {Promise<*>} Result of fn()
 */
async function withRetry(fn, options = {}) {
  const { maxRetries = 3, baseDelay = 1000, maxDelay = 30000, shouldRetry } = options;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const gwError = err instanceof GatewayError ? err : classifyError(err);

      // Don't retry non-recoverable errors
      if (!gwError.recoverable) throw gwError;
      if (shouldRetry && !shouldRetry(gwError)) throw gwError;
      if (attempt === maxRetries) throw gwError;

      // Exponential backoff with jitter
      const delay = Math.min(baseDelay * Math.pow(2, attempt) + Math.random() * 500, maxDelay);
      log.debug(`Retrying in ${Math.round(delay)}ms (attempt ${attempt + 1}/${maxRetries})...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

export { ErrorCategory, GatewayError, classifyError, handleError, withRetry };
export default { ErrorCategory, GatewayError, classifyError, handleError, withRetry };
