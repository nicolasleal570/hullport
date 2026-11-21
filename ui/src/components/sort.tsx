import { setUi, useUi, type Section } from "../lib/store";
import { IconCheck } from "./icons";
import { openMenuAt } from "./menu";
import { IconButton } from "./ui";

/**
 * List sort options, shared by every list:
 * 0 = Name, 1 = a list-specific key, 2 = Newest, 3 = Oldest. Default is 0.
 */
export const SORT_LABELS = (special: string) => ["Name", special, "Newest", "Oldest"];

/** Map a sort option to a table column id + direction. */
export function sortFor(option: number, specialId: string, specialDesc: boolean, createdId = "created") {
  switch (option) {
    case 1: return { id: specialId, desc: specialDesc };
    case 2: return { id: createdId, desc: true };
    case 3: return { id: createdId, desc: false };
    default: return { id: "name", desc: false };
  }
}

export function useSortOption(section: Section) {
  return useUi((s) => s.sort[section] ?? 0);
}

export function SortButton({ section, special }: { section: Section; special: string }) {
  const current = useSortOption(section);
  return (
    <IconButton
      title={`Sort: ${SORT_LABELS(special)[current]}`}
      onClick={(e) =>
        openMenuAt(
          e.currentTarget as HTMLElement,
          SORT_LABELS(special).map((label, i) => ({
            label,
            icon: i === current ? <IconCheck size={13} /> : undefined,
            onClick: () => setUi((s) => ({ sort: { ...s.sort, [section]: i } })),
          })),
        )
      }
    >
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4.5 3v10M2.5 11l2 2 2-2M11.5 13V3M9.5 5l2-2 2 2" />
      </svg>
    </IconButton>
  );
}

import { useEffect, useState } from "react";

/** Sort state for a list: the toolbar option, overridable by clicking a column header. */
export function useListSort(section: Section, specialId: string, specialDesc: boolean) {
  const option = useSortOption(section);
  const [override, setOverride] = useState<{ id: string; desc?: boolean } | null>(null);
  useEffect(() => setOverride(null), [option]);
  return { sort: override ?? sortFor(option, specialId, specialDesc), onSortChange: setOverride };
}
