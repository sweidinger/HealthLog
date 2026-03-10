import { NextResponse } from "next/server";

export function apiSuccess<T>(data: T, status = 200) {
  return NextResponse.json({ data, error: null }, { status });
}

export function apiError(message: string, status = 400) {
  return NextResponse.json({ data: null, error: message }, { status });
}

/**
 * Safely parse JSON body from a request.
 * Returns the parsed body or a 400 error response if parsing fails.
 */
export async function safeJson<T = unknown>(
  request: Request,
): Promise<{ data: T; error?: never } | { data?: never; error: Response }> {
  const ct = request.headers.get("content-type");
  if (!ct || !ct.includes("application/json")) {
    return { error: apiError("Content-Type must be application/json", 415) };
  }
  try {
    const data = (await request.json()) as T;
    return { data };
  } catch {
    return { error: apiError("Invalid JSON body", 400) };
  }
}

export function getClientIp(request: Request): string | null {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return request.headers.get("x-real-ip");
}
