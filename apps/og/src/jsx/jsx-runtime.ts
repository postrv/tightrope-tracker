/**
 * Minimal JSX runtime for Satori.
 *
 * Satori happily consumes anything shaped like `{ type, props: { children, ...rest } }`,
 * so we ship the bare minimum of the automatic JSX runtime surface (`jsx`,
 * `jsxs`, `jsxDEV`, `Fragment`) without pulling in React.
 *
 * Component functions are called inline; their return value is spliced into
 * the tree. Satori itself does not execute components, so we eagerly evaluate
 * functional components here.
 */

export type Child = string | number | boolean | null | undefined | JsxNode | Child[];

export interface JsxNode {
  type: string;
  props: { children?: Child } & Record<string, unknown>;
  key?: string | number | null;
}

export const Fragment = Symbol.for("satori.fragment");

type FC = (props: Record<string, unknown>) => JsxNode | Child;

/**
 * Classic-runtime JSX factory (configured as `h` in tsconfig.json).
 *
 * TSX compiles `<div foo="a">x</div>` to `h("div", { foo: "a" }, "x")`. We
 * gather the trailing child arguments and splice them into `props.children`
 * so Satori (which expects `{ type, props: { children, ... } }`) is happy.
 */
export function h(
  type: unknown,
  props: Record<string, unknown> | null,
  ...children: Child[]
): JsxNode {
  const flatChildren = flattenChildren(children);
  const normalisedChildren: Child =
    flatChildren.length === 0 ? undefined
      : flatChildren.length === 1 ? flatChildren[0]
      : flatChildren;

  if (typeof type === "function") {
    const p: Record<string, unknown> = { ...(props ?? {}) };
    if (normalisedChildren !== undefined) p.children = normalisedChildren;
    const result = (type as FC)(p);
    if (isNode(result)) return result;
    return { type: "span", props: { children: result as Child } };
  }

  if (type === Fragment) {
    return { type: "div", props: { children: normalisedChildren } };
  }

  if (typeof type !== "string") {
    throw new Error(`Unsupported JSX element type: ${String(type)}`);
  }

  const finalProps: Record<string, unknown> = { ...(props ?? {}) };
  if (normalisedChildren !== undefined) finalProps.children = normalisedChildren;
  return { type, props: finalProps };
}

function flattenChildren(children: Child[]): Child[] {
  const out: Child[] = [];
  for (const c of children) {
    if (c === null || c === undefined || c === false || c === true) continue;
    if (Array.isArray(c)) {
      const flat = flattenChildren(c);
      for (const f of flat) out.push(f);
    } else {
      out.push(c);
    }
  }
  return out;
}

function isNode(v: unknown): v is JsxNode {
  return typeof v === "object" && v !== null && "type" in (v as object) && "props" in (v as object);
}

// Re-exports for anyone using the automatic runtime shape.
export const jsx = h;
export const jsxs = h;
export const jsxDEV = h;
