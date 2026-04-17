/**
 * Minimal JSX typings for the Satori runtime. We only render `div` / `span` /
 * `svg` / `img`-style elements with flexbox-ish style objects. The types are
 * deliberately permissive — correctness is enforced at render time.
 */
import type { JsxNode } from "./jsx-runtime.js";

type SatoriStyle = Record<string, string | number>;

interface SatoriIntrinsicProps {
  style?: SatoriStyle;
  children?: unknown;
  tw?: string;
  // Common attributes Satori supports; everything else is passed through.
  [key: string]: unknown;
}

declare global {
  namespace JSX {
    type Element = JsxNode;
    interface IntrinsicElements {
      [elemName: string]: SatoriIntrinsicProps;
    }
    interface ElementChildrenAttribute {
      children: unknown;
    }
  }
}
