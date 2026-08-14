import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, fetchSimState, toConnectionErrorInfo } from '../api';
import {
  SimSnapshotGate,
  snapshotSchemaRejectionMessage,
  subscribeToSimSessionInvalidation,
} from '../state/simState';
import {
  createInitialConnectionMetadata,
  type ConnectionMetadata,
  type SimData,
  type SimHookResult,
} from '../types/sim';

// Preserve the original import surface while contracts live in one place.
export type {
  Advisory,
  AirportReference,
  ConflictAlert,
  DataQuality,
  EmergencyAction,
  EmergencyState,
  RoutePlan,
  RouteProgress,
  ScenarioControlState,
  SimData,
  TrafficContact,
  WeatherData,
} from '../types/sim';

export function useSimData(pollInterval = 1_500): SimHookResult {
  const gateRef = useRef(new SimSnapshotGate());
  const [data, setData] = useState<SimData>(() => gateRef.current.current);
  const [connection, setConnection] = useState<ConnectionMetadata>(() =>
    createInitialConnectionMetadata('polling'),
  );
  const [clock, setClock] = useState(() => Date.now());
  const mountedRef = useRef(false);
  const failureCountRef = useRef(0);
  const requestRef = useRef<AbortController | null>(null);
  const inFlightRef = useRef<Promise<void> | null>(null);

  const poll = useCallback(async (): Promise<void> => {
    if (inFlightRef.current) return inFlightRef.current;

    const controller = new AbortController();
    const expectedRevision = gateRef.current.currentRevision;
    requestRef.current = controller;
    setConnection(previous => ({
      ...previous,
      status: previous.backend_online ? 'online' : 'connecting',
      next_retry_at: null,
    }));

    const task = (async () => {
      try {
        const payload = await fetchSimState({
          signal: controller.signal,
          timeoutMs: Math.max(4_000, Math.min(12_000, pollInterval * 2)),
        });
        if (!mountedRef.current) return;

        const result = gateRef.current.accept(payload, {
          transport: 'polling',
          expectedRevision,
        });
        failureCountRef.current = 0;

        if (result.accepted) {
          const receivedAtMs = result.snapshot.timestamps.received_at_ms;
          setData(result.snapshot);
          setClock(Date.now());
          setConnection(previous => ({
            ...previous,
            status: 'online',
            backend_online: true,
            reconnecting: false,
            attempt: 0,
            connected_at: previous.connected_at ?? new Date(receivedAtMs).toISOString(),
            last_message_at: new Date(receivedAtMs).toISOString(),
            last_message_at_ms: receivedAtMs,
            next_retry_at: null,
            last_error: null,
            schema_compatible: true,
            schema_error: null,
          }));
        } else {
          const schemaError = snapshotSchemaRejectionMessage(result.reason);
          setConnection(previous => ({
            ...previous,
            status: 'online',
            backend_online: true,
            rejected_snapshots: previous.rejected_snapshots + 1,
            last_rejection_reason: result.reason,
            ...(schemaError ? { schema_compatible: false, schema_error: schemaError } : {}),
          }));
        }
      } catch (error) {
        if (!mountedRef.current || (error instanceof ApiError && error.code === 'ABORTED')) return;
        failureCountRef.current += 1;
        const offline = failureCountRef.current >= 2;
        setConnection(previous => ({
          ...previous,
          status: offline ? 'offline' : 'degraded',
          backend_online: !offline && previous.backend_online,
          reconnecting: true,
          attempt: failureCountRef.current,
          disconnected_at: offline ? new Date().toISOString() : previous.disconnected_at,
          last_error: toConnectionErrorInfo(error),
        }));
      }
    })();

    inFlightRef.current = task;
    try {
      await task;
    } finally {
      if (inFlightRef.current === task) inFlightRef.current = null;
      if (requestRef.current === controller) requestRef.current = null;
    }
  }, [pollInterval]);

  useEffect(() => {
    mountedRef.current = true;
    void poll();

    const pollTimer = window.setInterval(() => void poll(), Math.max(250, pollInterval));
    const ageTimer = window.setInterval(() => setClock(Date.now()), 1_000);
    const unsubscribe = subscribeToSimSessionInvalidation(event => {
      requestRef.current?.abort();
      inFlightRef.current = null;
      const resetState = gateRef.current.reset(event.session_id ?? undefined);
      failureCountRef.current = 0;
      setData(resetState);
      setClock(Date.now());
      setConnection(previous => ({
        ...previous,
        status: 'connecting',
        reconnecting: true,
        last_message_at: null,
        last_message_at_ms: null,
        last_rejection_reason: null,
      }));
      void poll();
    });

    return () => {
      mountedRef.current = false;
      window.clearInterval(pollTimer);
      window.clearInterval(ageTimer);
      unsubscribe();
      requestRef.current?.abort();
      requestRef.current = null;
      inFlightRef.current = null;
    };
  }, [poll, pollInterval]);

  const resync = useCallback(async (): Promise<void> => {
    await poll();
  }, [poll]);

  const dataAgeMs = connection.last_message_at_ms === null
    ? null
    : Math.max(0, clock - connection.last_message_at_ms);
  const staleAfterMs = Math.max(5_000, pollInterval * 3);
  const dataStale = dataAgeMs === null || dataAgeMs > staleAfterMs || data.quality.stale;
  const backendOnline = connection.backend_online;

  return {
    ...data,
    data_age_ms: dataAgeMs ?? undefined,
    backendOnline,
    reconnecting: connection.reconnecting,
    connection,
    dataAgeMs,
    dataStale,
    lastUpdatedAt: connection.last_message_at,
    resync,
  };
}
