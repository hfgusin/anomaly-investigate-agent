export type GatewayRequest = {
  type: "req";
  id: string;
  method: string;
  params?: Record<string, unknown>;
};

export type GatewayResponse =
  | { type: "res"; id: string; ok: true; payload: unknown }
  | { type: "res"; id: string; ok: false; error: { code: string; message: string; retryAfterMs?: number } };

export type GatewayEvent = {
  type: "event";
  event: string;
  payload: Record<string, unknown>;
  seq: number;
};

export function parseRequest(value: unknown): GatewayRequest | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.type !== "req" ||
    typeof candidate.id !== "string" || !candidate.id || candidate.id.length > 128 ||
    typeof candidate.method !== "string" || !candidate.method || candidate.method.length > 128 ||
    (candidate.params !== undefined &&
      (typeof candidate.params !== "object" || candidate.params === null || Array.isArray(candidate.params)))
  ) {
    return null;
  }

  return candidate as GatewayRequest;
}
