interface JsonRpcError {
    code?: number | string;
    message?: string;
    statusCode?: number;
    cause?: {
        code?: number | string;
        message?: string;
    };
    response?: {
        statusCode?: number;
    };
}

type ErrorType = 'SOCKET' | 'NETWORK' | 'TIMEOUT' | 'RATE_LIMIT' | 'SERVER' | 'RPC_SERVER' | 'CLIENT' | 'UNKNOWN';

const FIXED_TOTAL_RETRIES = 5; // Global Total Retries
const FIXED_BASE_DELAY = 100; // Base delay in ms
const FIXED_MAX_DELAY = 5000; // Max delay in ms

//    These act as the primary retry limits for each error category.
const INTERNAL_FIXED_RETRIES: Record<ErrorType, number> = {
    SOCKET: 5,      // Connection/Socket errors (high retry chance)
    NETWORK: 3,     // DNS/Reachability errors
    TIMEOUT: 3,     // Request timeouts
    RATE_LIMIT: 5,  // 429 errors (high retry chance after delay)
    SERVER: 2,      // HTTP 5xx errors
    RPC_SERVER: 2,  // JSON-RPC internal errors (-32xxx)
    CLIENT: 0,      // Client errors (4xx) are never retried
    UNKNOWN: 1      // Unclassified errors (minimal safeguard retry)
};

function classifyError(error: JsonRpcError): ErrorType {
    const code = error.code || error.cause?.code || '';
    const message = (error.message || error.cause?.message || '').toLowerCase();
    const statusCode = error.statusCode || error.response?.statusCode;

    // Socket Errors (OS/Connection issues)
    if (['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ECONNABORTED'].includes(String(code))) return 'SOCKET';
    // Network Errors (Host/Route issues)
    if (['ETIMEDOUT', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH'].includes(String(code))) return 'NETWORK';
    // Timeout Errors (Message/Internal time limits)
    if (message.includes('timeout') || message.includes('timed out')) return 'TIMEOUT';
    // Rate Limit Errors (HTTP 429)
    if (statusCode === 429 || code === 429 || message.includes('rate limit')) return 'RATE_LIMIT';
    // RPC Server Errors (Specific JSON-RPC codes)
    if ([-32000, -32603, -32601, -32600].includes(Number(code))) return 'RPC_SERVER';
    if (typeof statusCode === 'number') {
        // Server Errors (HTTP 5xx)
        if (statusCode >= 500) return 'SERVER';
        // Client Errors (HTTP 4xx - Non-retryable)
        if (statusCode >= 400) return 'CLIENT';
    }
    return 'UNKNOWN';
}

// ====== Check if Error is Retryable ======
function isRetryable(error: JsonRpcError): boolean {
    const type = classifyError(error);
    if (type === 'CLIENT') return false;
    const retryableTypes: ErrorType[] = ['SOCKET', 'NETWORK', 'TIMEOUT', 'RATE_LIMIT', 'SERVER', 'RPC_SERVER', 'UNKNOWN'];
    return retryableTypes.includes(type);
}

// ====== Delay Computation (Exponential Backoff with Jitter) ======
function computeDelay(attempt: number): number {
    const base = FIXED_BASE_DELAY;
    const max = FIXED_MAX_DELAY;
    if (attempt < 0) return base;
    let delay = base * Math.pow(2, attempt);
    delay = Math.min(delay, max);
    const jitter = delay * 0.2 * (Math.random() * 2 - 1);
    return Math.floor(Math.max(delay + jitter, 0));
}

export async function stableRetry<T>(
    fn: (...args: unknown[]) => Promise<T>,
    ...args: unknown[]
): Promise<T> {

    const totalRetries = FIXED_TOTAL_RETRIES;
    const errorTypeRetries = INTERNAL_FIXED_RETRIES;

    // Tracks failure count per error type
    const errorTypeCount: Record<ErrorType, number> = {
        SOCKET: 0, NETWORK: 0, TIMEOUT: 0, RATE_LIMIT: 0,
        SERVER: 0, RPC_SERVER: 0, CLIENT: 0, UNKNOWN: 0
    };

    let lastError: JsonRpcError = {};
    let totalAttempts = 0; // Total number of failed attempts
    while (true) {
        try {
            // Attempt the operation
            return await fn(...args);
        } catch (err: any) {
            lastError = err;
            totalAttempts++;

            const type = classifyError(err);

            // 1. Non-retryable error check (e.g., CLIENT errors): THROWS IMMEDIATELY
            if (!isRetryable(err)) {
                const wrapErr = new Error(`Non-retryable error: ${err.message} (type: ${type})`);
                wrapErr.cause = err;
                throw wrapErr;
            }

            // 2. Increment count for the specific error type
            errorTypeCount[type] += 1;

            // 3. Check: Exceeded max attempts for the CURRENT ERROR TYPE (Primary limit)
            const typeMax = errorTypeRetries[type] || 0;
            if (errorTypeCount[type] > typeMax) {
                break;
            }

            // 4. Check: Exceeded max TOTAL retries (Global fallback limit)
            if (totalAttempts > totalRetries) {
                break;
            }

            // 5. Compute delay using (count - 1) for the correct exponential attempt index
            const delay = computeDelay(errorTypeCount[type] - 1);
            await new Promise(r => setTimeout(r, delay));
        }
    }

    // Final failure: Throw a consolidated error
    const lastErrorType = classifyError(lastError);
    const finalError = new Error(`Retry failed after ${totalAttempts} attempts (last error type: ${lastErrorType}): ${lastError?.message || 'Unknown error'}`);
    finalError.cause = lastError;
    throw finalError;
}
