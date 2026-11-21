import { useSyncExternalStore } from "react";

export interface Toast { id: number; kind: "info" | "ok" | "error"; text: string }
let toasts: Toast[] = [];
let n = 0;
const ls = new Set<() => void>();
const emit = () => ls.forEach((l) => l());

export function toast(text: string, kind: Toast["kind"] = "info", ms = kind === "error" ? 7000 : 3200) {
  const id = ++n;
  toasts = [...toasts, { id, kind, text }].slice(-4);
  emit();
  setTimeout(() => dismiss(id), ms);
}
export function dismiss(id: number) {
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}
export const useToasts = () =>
  useSyncExternalStore((cb) => { ls.add(cb); return () => ls.delete(cb); }, () => toasts);
