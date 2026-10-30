import { API_URL } from "../../config/env.js";

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/**
 * GET a backend endpoint and unwrap its `{ message, data, status }` envelope.
 * `params` with undefined/null values are dropped from the query string.
 */
export async function get(path, params = {}, { signal } = {}) {
  const url = new URL(`${API_URL}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  }

  const res = await fetch(url, { signal, headers: { Accept: "application/json" } });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(body?.message ?? res.statusText, res.status);
  return body?.data;
}
