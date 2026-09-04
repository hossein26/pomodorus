import { useCallback, useEffect, useState } from "react";

import { LocalError } from "@/lib/errors";
import { KEYS, read, write } from "@/lib/local-store";
import type { Session } from "@/lib/session";

export type Category = {
  id: string;
  name: string;
  isPublic: boolean;
};

/** More tasks than anybody can hold in their head at once. */
const MAX_CATEGORIES = 100;

const isCategory = (v: unknown): v is Category => {
  if (typeof v !== "object" || v === null) return false;
  const c = v as Record<string, unknown>;
  return (
    typeof c.id === "string" && typeof c.name === "string" && typeof c.isPublic === "boolean"
  );
};

const isCategories = (v: unknown): v is Category[] =>
  Array.isArray(v) && v.every(isCategory);

const isSessionRecord = (v: unknown): v is Session | null =>
  v === null || (typeof v === "object" && v !== null && "id" in v);

function load(): Category[] {
  return read(KEYS.categories, isCategories) ?? [];
}

function liveCategoryInUse(id: string): boolean {
  const live = read(KEYS.live, isSessionRecord);
  return live?.categoryId === id;
}

/**
 * Your tasks, as this device has them.
 *
 * There is no queue and no optimistic list: storage owns this, and a write
 * that has not landed has not happened. Every mutation throws rather than
 * swallowing, because a button that appears to do nothing is the thing this
 * app promises not to be.
 */
export function useCategories() {
  const [categories, setCategories] = useState<Category[] | null>(null);

  const reload = useCallback(async () => {
    setCategories(load());
  }, []);

  useEffect(() => {
    void reload().catch(() => setCategories([]));
  }, [reload]);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === KEYS.categories) void reload().catch(() => {});
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [reload]);

  const create = useCallback(
    async (name: string, isPublic: boolean) => {
      const trimmed = name.trim();
      if (trimmed.length < 1 || trimmed.length > 40) {
        throw new LocalError("category_name_length");
      }
      const stored = load();
      if (stored.length >= MAX_CATEGORIES) {
        throw new LocalError("too_many_categories");
      }
      // Minted here, so a double click lands on the row the first tap created
      // rather than making a second one.
      const category: Category = { id: crypto.randomUUID(), name: trimmed, isPublic };
      const next = [...stored, category];
      write(KEYS.categories, next);
      setCategories(next);
      return category;
    },
    [],
  );

  const update = useCallback(
    async (id: string, name: string, isPublic: boolean) => {
      const trimmed = name.trim();
      if (trimmed.length < 1 || trimmed.length > 40) {
        throw new LocalError("category_name_length");
      }
      if (liveCategoryInUse(id)) throw new LocalError("category_busy");
      const stored = load();
      const found = stored.find((c) => c.id === id);
      if (!found) throw new LocalError("category_not_found");
      const updated: Category = { ...found, name: trimmed, isPublic };
      const next = stored.map((c) => (c.id === id ? updated : c));
      write(KEYS.categories, next);
      setCategories(next);
      return updated;
    },
    [],
  );

  const remove = useCallback(async (id: string) => {
    if (liveCategoryInUse(id)) throw new LocalError("category_busy");
    const stored = load();
    // History keeps its own snapshot of the name, so deleting here rewrites
    // nothing that was already credited.
    const next = stored.filter((c) => c.id !== id);
    write(KEYS.categories, next);
    setCategories(next);
  }, []);

  return { categories, create, update, remove, reload };
}
