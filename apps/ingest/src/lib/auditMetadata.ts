import { sanitizeForLog } from "./sanitize.js";

const CREDENTIAL_PARAMETER = /(?:api[_-]?(?:key|token)|access[_-]?token|token|key|secret|signature|password|authorization|credential)/i;

/** Audit provenance is public operational metadata, never an authenticated URL. */
export function sanitizeAuditUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (CREDENTIAL_PARAMETER.test(key)) url.searchParams.set(key, "[redacted]");
    }
    return sanitizeForLog(url.toString());
  } catch {
    return "[invalid source URL]";
  }
}

export function sanitizeAuditReason(value: string, secrets: readonly (string | undefined)[]): string {
  let safe = value;
  for (const secret of secrets) {
    if (!secret) continue;
    safe = safe.split(secret).join("[redacted]");
    safe = safe.split(encodeURIComponent(secret)).join("[redacted]");
  }
  safe = safe.replace(/([?&](?:api[_-]?(?:key|token)|access[_-]?token|token|key|secret|signature|password|authorization|credential)=)[^&#\s]*/gi, "$1[redacted]");
  return sanitizeForLog(safe).slice(0, 2000);
}
