import { useSyncExternalStore } from 'react';

export const DEFAULT_TRAINING_SESSION_ID = 'default';
const STORAGE_KEY = 'skycommand.active-training-session.v1';
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function normalizeStoredSessionId(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_TRAINING_SESSION_ID;
  const normalized = value.trim();
  return SESSION_ID_PATTERN.test(normalized) ? normalized : DEFAULT_TRAINING_SESSION_ID;
}

function loadInitialSessionId(): string {
  if (typeof window === 'undefined') return DEFAULT_TRAINING_SESSION_ID;
  try {
    return normalizeStoredSessionId(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return DEFAULT_TRAINING_SESSION_ID;
  }
}

let activeTrainingSessionId = loadInitialSessionId();
const listeners = new Set<() => void>();
let fallbackNotice: string | null = null;
const fallbackListeners = new Set<() => void>();

export function isValidTrainingSessionId(value: string): boolean {
  return SESSION_ID_PATTERN.test(value.trim());
}

export function getActiveTrainingSessionId(): string {
  return activeTrainingSessionId;
}

export function setActiveTrainingSessionId(value: string): string {
  const normalized = normalizeStoredSessionId(value);
  if (normalized === activeTrainingSessionId) return normalized;
  activeTrainingSessionId = normalized;
  if (typeof window !== 'undefined') {
    try {
      if (normalized === DEFAULT_TRAINING_SESSION_ID) window.localStorage.removeItem(STORAGE_KEY);
      else window.localStorage.setItem(STORAGE_KEY, normalized);
    } catch {
      // Storage is an optimization. The in-memory default-safe value remains authoritative.
    }
  }
  listeners.forEach((listener) => listener());
  return normalized;
}

export function resetActiveTrainingSession(): void {
  setActiveTrainingSessionId(DEFAULT_TRAINING_SESSION_ID);
}

export function reportTrainingSessionUnavailable(reason: string): void {
  const unavailableId = activeTrainingSessionId;
  if (unavailableId === DEFAULT_TRAINING_SESSION_ID) return;
  fallbackNotice = `Training room ${unavailableId.slice(0, 8)} is unavailable: ${reason} Returned to the default room.`;
  fallbackListeners.forEach((listener) => listener());
  setActiveTrainingSessionId(DEFAULT_TRAINING_SESSION_ID);
}

export function clearTrainingSessionFallbackNotice(): void {
  if (fallbackNotice === null) return;
  fallbackNotice = null;
  fallbackListeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useActiveTrainingSessionId(): string {
  return useSyncExternalStore(subscribe, getActiveTrainingSessionId, () => DEFAULT_TRAINING_SESSION_ID);
}

function subscribeToFallback(listener: () => void): () => void {
  fallbackListeners.add(listener);
  return () => fallbackListeners.delete(listener);
}

export function useTrainingSessionFallbackNotice(): string | null {
  return useSyncExternalStore(subscribeToFallback, () => fallbackNotice, () => null);
}
