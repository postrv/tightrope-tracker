import type { DataSourceAdapter } from "./types.js";

/** Runtime registry of installed adapters. Populated by `./adapters/*` on import. */
const registry = new Map<string, DataSourceAdapter>();

export function registerAdapter(adapter: DataSourceAdapter): void {
  registry.set(adapter.id, adapter);
}

export function getAdapter(id: string): DataSourceAdapter | undefined {
  return registry.get(id);
}

export function listAdapters(): readonly DataSourceAdapter[] {
  return Array.from(registry.values());
}
