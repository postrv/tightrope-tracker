/**
 * Font loader.
 *
 * Preferred path: read TTFs from the R2 `FONTS` binding (uploaded by
 * `scripts/upload-fonts.ts`). Module-scope memoisation means the first request
 * after a cold start pays the load cost; subsequent requests reuse the cached
 * bytes.
 *
 * Fallback path: if `env.FONTS` is undefined (local dev before R2 is
 * provisioned) we fetch the TTFs from public Google Fonts mirrors and log a
 * warning. Do not rely on this in production — it adds latency and an external
 * dependency.
 */

export interface SatoriFont {
  name: string;
  data: ArrayBuffer;
  weight: 300 | 400 | 500 | 600 | 700;
  style: "normal" | "italic";
}

interface FontSpec {
  r2Key: string;
  fallbackUrl: string;
  name: string;
  weight: SatoriFont["weight"];
  style: SatoriFont["style"];
}

// Font files we expect in R2. Keys are chosen for legibility on the command
// line — `upload-fonts.ts` writes to these same paths.
const FONT_SPECS: FontSpec[] = [
  {
    r2Key: "fraunces/Fraunces-Regular.ttf",
    // Static TTF mirrors of the Fraunces variable font at its common weights.
    fallbackUrl: "https://raw.githubusercontent.com/undercasetype/Fraunces/main/fonts/static/TTF/Fraunces-Regular.ttf",
    name: "Fraunces",
    weight: 400,
    style: "normal",
  },
  {
    r2Key: "fraunces/Fraunces-Light.ttf",
    fallbackUrl: "https://raw.githubusercontent.com/undercasetype/Fraunces/main/fonts/static/TTF/Fraunces-Light.ttf",
    name: "Fraunces",
    weight: 300,
    style: "normal",
  },
  {
    r2Key: "fraunces/Fraunces-Italic.ttf",
    fallbackUrl: "https://raw.githubusercontent.com/undercasetype/Fraunces/main/fonts/static/TTF/Fraunces-Italic.ttf",
    name: "Fraunces",
    weight: 400,
    style: "italic",
  },
  {
    r2Key: "inter/Inter-Regular.ttf",
    fallbackUrl: "https://raw.githubusercontent.com/rsms/inter/master/docs/font-files/Inter-Regular.otf",
    name: "Inter",
    weight: 400,
    style: "normal",
  },
  {
    r2Key: "inter/Inter-Medium.ttf",
    fallbackUrl: "https://raw.githubusercontent.com/rsms/inter/master/docs/font-files/Inter-Medium.otf",
    name: "Inter",
    weight: 500,
    style: "normal",
  },
  {
    r2Key: "inter/Inter-SemiBold.ttf",
    fallbackUrl: "https://raw.githubusercontent.com/rsms/inter/master/docs/font-files/Inter-SemiBold.otf",
    name: "Inter",
    weight: 600,
    style: "normal",
  },
  {
    r2Key: "plex/IBMPlexMono-Regular.ttf",
    fallbackUrl: "https://raw.githubusercontent.com/IBM/plex/master/IBM-Plex-Mono/fonts/complete/ttf/IBMPlexMono-Regular.ttf",
    name: "IBM Plex Mono",
    weight: 400,
    style: "normal",
  },
  {
    r2Key: "plex/IBMPlexMono-Medium.ttf",
    fallbackUrl: "https://raw.githubusercontent.com/IBM/plex/master/IBM-Plex-Mono/fonts/complete/ttf/IBMPlexMono-Medium.ttf",
    name: "IBM Plex Mono",
    weight: 500,
    style: "normal",
  },
];

export const FONT_R2_MANIFEST: ReadonlyArray<{ r2Key: string; fallbackUrl: string }> =
  FONT_SPECS.map(({ r2Key, fallbackUrl }) => ({ r2Key, fallbackUrl }));

let cached: Promise<SatoriFont[]> | null = null;

export function loadFonts(env: Env): Promise<SatoriFont[]> {
  if (!cached) cached = loadFontsUncached(env);
  return cached;
}

async function loadFontsUncached(env: Env): Promise<SatoriFont[]> {
  const results = await Promise.all(FONT_SPECS.map((spec) => loadOne(env, spec)));
  return results;
}

async function loadOne(env: Env, spec: FontSpec): Promise<SatoriFont> {
  if (env.FONTS) {
    const obj = await env.FONTS.get(spec.r2Key);
    if (obj) {
      const data = await obj.arrayBuffer();
      return { name: spec.name, data, weight: spec.weight, style: spec.style };
    }
    // R2 binding exists but the object is missing — fall through to HTTP as a
    // best-effort rescue and log so we find out about the misconfiguration.
    console.warn(`font missing from R2: ${spec.r2Key} — falling back to HTTP mirror`);
  } else {
    console.warn(`FONTS binding undefined — fetching ${spec.r2Key} via public mirror (dev only)`);
  }

  const res = await fetch(spec.fallbackUrl, { cf: { cacheTtl: 86400, cacheEverything: true } });
  if (!res.ok) throw new Error(`font fetch ${spec.fallbackUrl} -> ${res.status}`);
  const data = await res.arrayBuffer();
  return { name: spec.name, data, weight: spec.weight, style: spec.style };
}
