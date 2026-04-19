import { h } from "../jsx/jsx-runtime.js";
import type { JsxNode } from "../jsx/jsx-runtime.js";
import { CardShell, SERIF, TOKENS, formatDate } from "./components.js";

export interface DeliveryHousingProps {
  /** Most recent annualised net additions, in thousands. */
  currentThousands: number;
  /** Target thousands (305k for the 2030 target). */
  targetThousands: number;
  updatedAt: string;
}

/**
 * Delivery progress card with the "rope" visualisation from the mockup.
 *
 * Satori supports a subset of SVG — we use plain <svg>/<line>/<circle>/<text>.
 * The rope is a dim baseline stroke with a coloured progress stroke on top,
 * drawn inside a viewBox that matches the mockup's 1056×60 canvas.
 */
export function DeliveryHousingCard(props: DeliveryHousingProps): JsxNode {
  const { currentThousands, targetThousands, updatedAt } = props;
  const progress = Math.max(0, Math.min(1, currentThousands / targetThousands));
  const pct = Math.round(progress * 100);
  const progressX = Math.round(progress * 1056);

  return (
    <CardShell
      variant="rope"
      eyebrow="Tightrope Tracker · Delivery"
      meta={formatDate(updatedAt)}
      source="Source · MHCLG housing statistics · OBR trajectory"
      footerRight="Net additions, annualised"
    >
      <div style={{ display: "flex", flexDirection: "column", gap: "48px" }}>
        {/* Rope viz */}
        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              fontFamily: "IBM Plex Mono",
              fontSize: "14px",
              color: TOKENS.accent,
              paddingRight: "8px",
            }}
          >
            <span style={{ color: TOKENS.accent, marginLeft: `${Math.max(0, Math.round(progress * 100) - 6)}%` }}>
              {Math.round(currentThousands)}k today
            </span>
            <span style={{ color: TOKENS.ink0 }}>{Math.round(targetThousands)}k · 2030 target</span>
          </div>
          <svg width="1056" height="60" viewBox="0 0 1056 60" preserveAspectRatio="none" style={{ display: "block" }}>
            <defs>
              <linearGradient id="rope" x1="0" x2="1">
                <stop offset="0" stopColor={TOKENS.bandSlack} />
                <stop offset="0.55" stopColor={TOKENS.bandStrain} />
                <stop offset="1" stopColor={TOKENS.bandCritical} stopOpacity="0.35" />
              </linearGradient>
            </defs>
            <line x1="0" y1="30" x2="1056" y2="30" stroke={TOKENS.border} strokeWidth="3" strokeLinecap="round" />
            <line x1="0" y1="30" x2={progressX} y2="30" stroke="url(#rope)" strokeWidth="4" strokeLinecap="round" />
            <line x1="1056" y1="6" x2="1056" y2="54" stroke={TOKENS.ink0} strokeWidth="2" strokeLinecap="round" />
            <circle cx={progressX} cy="30" r="7" fill={TOKENS.accent} />
          </svg>
        </div>

        <div
          style={{
            display: "flex",
            fontFamily: SERIF,
            fontWeight: 700,
            fontSize: "84px",
            lineHeight: 1.0,
            letterSpacing: "-0.02em",
            color: TOKENS.ink0,
            maxWidth: "85%",
          }}
        >
          Housing: {pct}% of the way to the target
        </div>
      </div>
    </CardShell>
  ) as JsxNode;
}
