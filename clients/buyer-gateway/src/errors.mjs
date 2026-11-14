export class GatewayError extends Error {
  constructor(code, status = 409) { super(code); this.code = code; this.status = status; }
}
export function check(condition, code, status = 400) {
  if (!condition) throw new GatewayError(code, status);
}
export function publicError(error) {
  if (error instanceof GatewayError) return { status: error.status, code: error.code };
  // SDK errors may contain upstream request data. Only expose a bounded code.
  if (Number.isInteger(error?.status) && /^[a-z][a-z0-9_]{0,80}$/.test(error?.code)) {
    return { status: error.status >= 500 ? 502 : error.status, code: error.code };
  }
  return { status: 502, code: 'upstream_unavailable' };
}
