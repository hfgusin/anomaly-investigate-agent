/** Exported traces retain SQL and logs, but exclude configured credentials. */
export function redactTrace<T>(value: T): T {
  const secrets = Object.entries(process.env)
    .filter(([key, secret]) => /(?:api_?key|token|password|secret|cookie|private_key)$/i.test(key) && secret && secret.length >= 4)
    .map(([, secret]) => secret!)
    .sort((a, b) => b.length - a.length);
  const clean = (item: unknown): unknown => {
    if (typeof item === "string") {
      for (const secret of secrets) item = (item as string).split(secret).join("[REDACTED]");
      const text = (item as string).replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [REDACTED]");
      try { return JSON.stringify(clean(JSON.parse(text))); } catch { return text; }
    }
    if (Array.isArray(item)) return item.map(clean);
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).map(([key, field]) =>
      [key, /^(?:authorization|password|api_?key|access_token|refresh_token|token|secret|client_secret|cookie|private_key)$/i.test(key) ? "[REDACTED]" : clean(field)]));
    return item;
  };
  return clean(value) as T;
}
