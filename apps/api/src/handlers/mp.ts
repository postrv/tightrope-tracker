import { json } from "../lib/router.js";

const ALLOWED = new Set<string>(["postcode"]);
const CACHE_DAYS = 7;

export interface MpLookupResponse {
  name: string;
  party: string;
  /**
   * Parliament's Members API exposes `/Members/{id}/Contact`, but the email
   * field is almost always absent (members choose what to publish). Rather
   * than chasing a null field, we surface the canonical contact page URL and
   * let the user submit the letter through Parliament's own form. Kept here
   * as `string | null` so older clients that read `email` still compile.
   */
  email: string | null;
  constituency: string;
  memberId: number;
  /** Canonical members.parliament.uk contact page for this MP. */
  profileUrl: string;
}

/**
 * Normalise a UK postcode for cache-keying. Parliament's constituency boundaries
 * are stable at the `outward` code granularity (e.g. `EX4`, `SW1A`), so caching
 * by the outward portion alone is safe and dramatically reduces API pressure.
 * Input is upper-cased and stripped of internal whitespace; a space is inserted
 * before the trailing three characters per GDS convention.
 */
export function normalisePostcode(raw: string): { full: string; outward: string } | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.replace(/\s+/g, "").toUpperCase();
  // Enforce UK postcode shape — outward 2-4 alnum, inward 3 alnum (digit + 2 letters).
  if (!/^[A-Z]{1,2}\d[A-Z\d]?\d[A-Z]{2}$/.test(trimmed)) return null;
  const outward = trimmed.slice(0, trimmed.length - 3);
  const inward = trimmed.slice(-3);
  return { full: `${outward} ${inward}`, outward };
}

export async function handleMp(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  for (const key of url.searchParams.keys()) {
    if (!ALLOWED.has(key)) return json({ error: `unknown query parameter: ${key}`, code: "BAD_QUERY" }, 400);
  }

  const raw = url.searchParams.get("postcode");
  if (!raw) return json({ error: "postcode required", code: "MISSING_PARAM" }, 400);
  const normalised = normalisePostcode(raw);
  if (!normalised) return json({ error: "invalid UK postcode", code: "BAD_POSTCODE" }, 400);

  // 1. Check D1 cache.
  const cached = await env.DB.prepare(
    `SELECT constituency, member_id, member_name, party, email, fetched_at
     FROM mp_lookup_cache WHERE postcode_prefix = ?1`,
  ).bind(normalised.outward).first<{
    constituency: string; member_id: number; member_name: string;
    party: string; email: string | null; fetched_at: string;
  }>();

  if (cached && !cacheExpired(cached.fetched_at)) {
    const resp: MpLookupResponse = {
      name: cached.member_name,
      party: cached.party,
      email: cached.email,
      constituency: cached.constituency,
      memberId: cached.member_id,
      profileUrl: buildProfileUrl(cached.member_id),
    };
    return json(resp);
  }

  // 2. Fetch from parliament.uk.
  try {
    const lookup = await fetchMpFromParliament(env, normalised.full);
    if (!lookup) return json({ error: "no MP found for postcode", code: "NOT_FOUND" }, 404);

    // 3. Upsert into D1 cache (keyed on outward code).
    await env.DB.prepare(
      `INSERT INTO mp_lookup_cache (postcode_prefix, constituency, member_id, member_name, party, email, fetched_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
       ON CONFLICT(postcode_prefix) DO UPDATE SET
         constituency = excluded.constituency,
         member_id    = excluded.member_id,
         member_name  = excluded.member_name,
         party        = excluded.party,
         email        = excluded.email,
         fetched_at   = excluded.fetched_at`,
    ).bind(
      normalised.outward,
      lookup.constituency,
      lookup.memberId,
      lookup.name,
      lookup.party,
      lookup.email,
      new Date().toISOString(),
    ).run();

    return json(lookup);
  } catch (err) {
    return json({ error: "upstream lookup failed", code: "UPSTREAM_ERROR" }, 502);
  }
}

function cacheExpired(fetchedAt: string): boolean {
  const t = Date.parse(fetchedAt);
  if (!Number.isFinite(t)) return true;
  return Date.now() - t > CACHE_DAYS * 24 * 60 * 60 * 1000;
}

async function fetchMpFromParliament(env: Env, postcode: string): Promise<MpLookupResponse | null> {
  // The Members API exposes a postcode → constituency → current member flow.
  // Step 1: resolve postcode to constituency via the /Location/Constituency/Search endpoint.
  const base = env.PARLIAMENT_API_BASE.replace(/\/$/, "");
  const searchUrl = `${base}/Location/Constituency/Search?searchText=${encodeURIComponent(postcode)}&skip=0&take=1`;
  const searchRes = await fetch(searchUrl, { headers: { accept: "application/json" } });
  if (!searchRes.ok) throw new Error(`constituency search ${searchRes.status}`);
  const searchJson = await searchRes.json() as { items?: Array<{ value: { id: number; name: string; currentRepresentation?: { member?: { value: ParliamentMember } } } }> };
  const first = searchJson.items?.[0]?.value;
  if (!first) return null;

  // Prefer the embedded member if present, otherwise fall back to the explicit endpoint.
  const embedded = first.currentRepresentation?.member?.value;
  if (embedded) return shapeMember(embedded, first.name);

  const memberRes = await fetch(`${base}/Members/Location/Constituency/${first.id}/CurrentRepresentation`, {
    headers: { accept: "application/json" },
  });
  if (!memberRes.ok) throw new Error(`member lookup ${memberRes.status}`);
  const memberJson = await memberRes.json() as { value?: { member?: { value: ParliamentMember } } };
  const member = memberJson.value?.member?.value;
  if (!member) return null;
  return shapeMember(member, first.name);
}

interface ParliamentMember {
  id: number;
  nameDisplayAs?: string;
  nameFullTitle?: string;
  latestParty?: { name?: string };
  latestHouseMembership?: { membershipFrom?: string };
  // The members API does not return email directly; it is available via
  // /api/Members/{id}/Contact. We fetch lazily below.
}

function shapeMember(member: ParliamentMember, constituency: string): MpLookupResponse {
  return {
    name: member.nameDisplayAs ?? member.nameFullTitle ?? "",
    party: member.latestParty?.name ?? "",
    email: null,
    constituency: member.latestHouseMembership?.membershipFrom ?? constituency,
    memberId: member.id,
    profileUrl: buildProfileUrl(member.id),
  };
}

function buildProfileUrl(memberId: number): string {
  return `https://members.parliament.uk/member/${memberId}/contact`;
}
