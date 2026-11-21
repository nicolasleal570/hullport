import { useSyncExternalStore } from "react";

export type Section = "containers" | "images" | "volumes" | "builds" | "networks" | "engines";

interface UiState {
  section: Section;
  selected: Partial<Record<Section, string | null>>;
  search: Partial<Record<Section, string>>;
  detailTab: Partial<Record<Section, string>>;
  showStopped: boolean;
  imageFilter: "all" | "inuse" | "unused" | "dangling";
  collapsedGroups: Record<string, boolean>;
  listWidth: number;
  /** Per-list sort option: 0 Name, 1 list-specific, 2 Newest, 3 Oldest. */
  sort: Partial<Record<Section, number>>;
  /** Log view prefs and their defaults. */
  logsFontSize: number;
  logsWrapLines: boolean;
  logsSearchMode: "filter" | "highlight";
  /** Builds filter and step filter; both default to showing everything. */
  buildsFilter: "all" | "running" | "failed";
  stepFilter: "all" | "failed" | "slowest";
  showInternalSteps: boolean;
}

const saved = (() => {
  try { return JSON.parse(localStorage.getItem("berth.ui") ?? "{}"); } catch { return {}; }
})();

let state: UiState = {
  section: "containers",
  selected: {},
  search: {},
  detailTab: {},
  showStopped: true,
  imageFilter: "all",
  collapsedGroups: {},
  listWidth: 560,
  sort: {},
  logsFontSize: 12.5,
  logsWrapLines: false,
  logsSearchMode: "filter",
  buildsFilter: "all",
  stepFilter: "all",
  showInternalSteps: false,
  ...saved,
};
const listeners = new Set<() => void>();

export function setUi(patch: Partial<UiState> | ((s: UiState) => Partial<UiState>)) {
  const p = typeof patch === "function" ? patch(state) : patch;
  state = { ...state, ...p };
  const { section, showStopped, imageFilter, collapsedGroups, listWidth, sort, logsFontSize, logsWrapLines, logsSearchMode, buildsFilter, stepFilter, showInternalSteps } = state;
  localStorage.setItem("berth.ui", JSON.stringify({ section, showStopped, imageFilter, collapsedGroups, listWidth, sort, logsFontSize, logsWrapLines, logsSearchMode, buildsFilter, stepFilter, showInternalSteps }));
  listeners.forEach((l) => l());
}

export const getUi = () => state;

export function useUi<T>(sel: (s: UiState) => T): T {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    () => sel(state),
  );
}

export const select = (section: Section, id: string | null) =>
  setUi((s) => ({ selected: { ...s.selected, [section]: id } }));
export const setSearch = (section: Section, q: string) =>
  setUi((s) => ({ search: { ...s.search, [section]: q } }));
export const setTab = (section: Section, tab: string) =>
  setUi((s) => ({ detailTab: { ...s.detailTab, [section]: tab } }));
export const go = (section: Section, id?: string | null, tab?: string) =>
  setUi((s) => ({
    section,
    selected: id !== undefined ? { ...s.selected, [section]: id } : s.selected,
    detailTab: tab ? { ...s.detailTab, [section]: tab } : s.detailTab,
  }));
