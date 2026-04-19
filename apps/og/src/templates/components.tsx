/** Shared building blocks for every share card. */
import { h } from "../jsx/jsx-runtime.js";

// Keep these in sync with apps/web/src/styles/tokens.css (light default).
// Satori can't read CSS custom properties, so we mirror the LFG brand values
// locally. OG cards render on the cream light theme for brand consistency
// across the web app and social share surfaces.
export const TOKENS = {
  bg0: "#EBE3D0",
  bg1: "#F4EEE0",
  border: "#C7BBA0",
  ink0: "#000000",
  ink1: "#2A2825",
  ink2: "#5A554A",
  accent: "#FE5500",
  accentDeep: "#C94400",
  accentWarm: "#EE9944",
  accentCool: "#79CAC4",
  bandSlack: "#5FB27C",
  bandSteady: "#79CAC4",
  bandStrain: "#EE9944",
  bandAcute: "#FE5500",
  bandCritical: "#C84B3C",
} as const;

export const SERIF = "Bricolage Grotesque";
export const SANS = "DM Sans";
export const MONO = "IBM Plex Mono";

export const CARD_W = 1200;
export const CARD_H = 630;

export interface CardShellProps {
  /** Short eyebrow beside the logo (e.g. "Tightrope Tracker · Headline"). */
  eyebrow: string;
  /** Top-right meta text — usually a date (e.g. "17.04.2026"). */
  meta: string;
  /** Source string in the footer. */
  source: string;
  /** Right-hand footer note. */
  footerRight: string;
  /** Background variant. */
  variant: "critical" | "accent" | "sober" | "warn" | "rope";
  children?: unknown;
}

/**
 * The subtle grid texture from the mockup, at ~6% opacity. Satori can render
 * background-image gradients, so we stack two linear-gradients to produce the
 * grid lines and clamp opacity with a containing layer.
 */
function GridOverlay() {
  return (
    <div
      style={{
        position: "absolute",
        top: "0",
        left: "0",
        right: "0",
        bottom: "0",
        opacity: 0.06,
        backgroundImage: `
          linear-gradient(to right, ${TOKENS.ink2} 1px, transparent 1px),
          linear-gradient(to bottom, ${TOKENS.ink2} 1px, transparent 1px)
        `,
        backgroundSize: "80px 80px",
      }}
    />
  );
}

/**
 * Tightrope Tracker logomark — three stacked horizontal bars (orange, blue,
 * black) stepped from wide to narrow, echoing the LFG "Progressing" graphical
 * motif. Satori doesn't support pseudo-elements, so each bar is an explicit
 * child div inside a 28×20 flex column.
 */
export function BrandLogo() {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "3px",
        width: "28px",
        height: "20px",
      }}
    >
      <div style={{ display: "flex", width: "28px", height: "4px", backgroundColor: TOKENS.accent }} />
      <div style={{ display: "flex", width: "20px", height: "4px", backgroundColor: TOKENS.accentCool }} />
      <div style={{ display: "flex", width: "12px", height: "4px", backgroundColor: TOKENS.ink0 }} />
    </div>
  );
}

function variantBackground(v: CardShellProps["variant"]): string {
  switch (v) {
    case "critical":
      // Critical red glow sits in the top-right over cream.
      return `
        radial-gradient(ellipse 60% 40% at 80% 20%, rgba(200, 75, 60, 0.22), transparent 70%),
        linear-gradient(135deg, ${TOKENS.bg1} 0%, ${TOKENS.bg0} 100%)
      `;
    case "accent":
      return `
        radial-gradient(ellipse 60% 40% at 80% 20%, rgba(254, 85, 0, 0.18), transparent 70%),
        linear-gradient(135deg, ${TOKENS.bg1} 0%, ${TOKENS.bg0} 100%)
      `;
    case "warn":
      return `
        radial-gradient(ellipse 60% 40% at 80% 20%, rgba(238, 153, 68, 0.22), transparent 70%),
        linear-gradient(135deg, ${TOKENS.bg1} 0%, ${TOKENS.bg0} 100%)
      `;
    case "rope":
      return `linear-gradient(180deg, ${TOKENS.bg1} 0%, ${TOKENS.bg0} 100%)`;
    default:
      return `linear-gradient(135deg, ${TOKENS.bg1} 0%, ${TOKENS.bg0} 100%)`;
  }
}

function variantBorder(v: CardShellProps["variant"]): string {
  switch (v) {
    case "critical": return "rgba(200, 75, 60, 0.45)";
    case "accent":   return "rgba(254, 85, 0, 0.35)";
    case "warn":     return "rgba(238, 153, 68, 0.40)";
    default:         return TOKENS.border;
  }
}

/**
 * Card shell: the 1200×630 frame with the brand row at the top, a free-form
 * body area in the middle, and the source footer at the bottom. Every card in
 * the product uses this wrapper.
 */
export function CardShell(props: CardShellProps) {
  const { eyebrow, meta, source, footerRight, variant, children } = props;
  return (
    <div
      style={{
        width: `${CARD_W}px`,
        height: `${CARD_H}px`,
        padding: "64px 72px",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        position: "relative",
        backgroundImage: variantBackground(variant),
        backgroundColor: TOKENS.bg1,
        border: `1px solid ${variantBorder(variant)}`,
        color: TOKENS.ink0,
        fontFamily: SANS,
        overflow: "hidden",
      }}
    >
      <GridOverlay />

      {/* Top — brand row */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          fontFamily: MONO,
          fontSize: "14px",
          letterSpacing: "0.14em",
          textTransform: "uppercase",
          color: TOKENS.ink2,
          zIndex: 1,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "14px" }}>
          <BrandLogo />
          <span>{eyebrow}</span>
        </div>
        <span>{meta}</span>
      </div>

      {/* Middle — supplied by caller */}
      <div style={{ display: "flex", flexDirection: "column", zIndex: 1 }}>
        {children as never}
      </div>

      {/* Bottom — source strip */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-end",
          fontFamily: MONO,
          fontSize: "14px",
          color: TOKENS.ink2,
          letterSpacing: "0.06em",
          zIndex: 1,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
          <div style={{ width: "20px", height: "1px", backgroundColor: TOKENS.accent, display: "flex" }} />
          <span style={{ color: TOKENS.ink1, letterSpacing: "0.18em" }}>{source}</span>
        </div>
        <span>{footerRight}</span>
      </div>
    </div>
  );
}

/**
 * Large display number using the serif. `value` is the main figure; `unit` is
 * a trailing label (e.g. "/100", "bn", "%"). Optional `tint` overrides the ink
 * colour — used on the headline card (critical red) and the fiscal accent card.
 */
export interface BigStatProps {
  value: string;
  unit?: string;
  tint?: string;
  size?: number;
}

export function BigStat({ value, unit, tint, size }: BigStatProps) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "baseline",
        fontFamily: SERIF,
        fontWeight: 700,
        fontSize: `${size ?? 148}px`,
        lineHeight: 0.92,
        letterSpacing: "-0.035em",
        color: tint ?? TOKENS.ink0,
      }}
    >
      <span>{value}</span>
      {unit ? (
        <span style={{ fontSize: `${Math.round((size ?? 148) * 0.38)}px`, color: TOKENS.ink2, fontWeight: 400, marginLeft: "8px" }}>
          {unit}
        </span>
      ) : null}
    </div>
  );
}

/**
 * Italic serif caption below the big stat. Used for the editorial one-liner
 * that gives the number its meaning.
 */
export function Caption({ children }: { children?: unknown }) {
  return (
    <div
      style={{
        display: "flex",
        fontFamily: SANS,
        fontStyle: "italic",
        fontWeight: 400,
        fontSize: "34px",
        lineHeight: 1.2,
        letterSpacing: "-0.01em",
        color: TOKENS.ink1,
        maxWidth: "85%",
        marginTop: "14px",
      }}
    >
      {children as never}
    </div>
  );
}

/**
 * Band pill shown above the headline stat. Colour + outline follow the band
 * tone; uppercase mono text matches the brand row.
 */
export function BandChip({ label, color }: { label: string; color: string }) {
  return (
    <div
      style={{
        display: "flex",
        alignSelf: "flex-start",
        fontFamily: MONO,
        fontSize: "13px",
        letterSpacing: "0.18em",
        textTransform: "uppercase",
        color,
        padding: "6px 14px",
        border: `1px solid ${color}73`,
        borderRadius: "999px",
        marginBottom: "24px",
      }}
    >
      {label}
    </div>
  );
}

export function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const yy = d.getUTCFullYear();
  return `${dd}.${mm}.${yy}`;
}
