import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ApiError,
  fetchSimState,
  SIM_STATE_WS_URL,
  toConnectionErrorInfo,
} from '../api';
import {
  SimSnapshotGate,
  subscribeToSimSessionInvalidation,
} from '../state/simState';
import {
  createInitialConnectionMetadata,
  type ConnectionErrorInfo,
  type ConnectionMetadata,
  type SimData,
  type SimHookResult,
  type SnapshotRejectionReason,
} from '../types/sim';

const MIN_RECONNECT_MS = 500;
const MAX_RECONNECT_MS = 15_000;
const CONNECT_TIMEOUT_MS = 10_000;
const STREAM_SILENCE_TIMEOUT_MS = 12_000;
const DATA_STALE_AFTER_MS = 5_000;

function websocketError(code: string, message: string): ConnectionErrorInfo {
  return {
    code,
    message,
    status: null,
    retryable: true,
    occurred_at: new Date().toISOString(),
  };
}

export function useSimStream(): SimHookResult {
  const gateRef = useRef(new SimSnapshotGate());
  const [data, setData] = useState<SimData>(() => gateRef.current.current);
  const [connection, setConnection] = useState<ConnectionMetadata>(() =>
    createInitialConnectionMetadata('websocket'),
  );
  const [clock, setClock] = useState(() => Date.now());
  const mountedRef = useRef(false);
  const socketRef = useRef<WebSocket | null>(null);
  const socketOnlineRef = useRef(false);
  const restReachableRef = useRef(false);
  const resyncRequestRef = useRef<AbortController | null>(null);

  const resync = useCallback(async (): Promise<void> => {
    resyncRequestRef.current?.abort();
    const controller = new AbortController();
    const expectedRevision = gateRef.current.currentRevision;
    resyncRequestRef.current = controller;

    try {
      const payload = await fetchSimState({ signal: controller.signal });
      if (!mountedRef.current || resyncRequestRef.current !== controller) return;
      restReachableRef.current = true;
      const result = gateRef.current.accept(payload, {
        transport: 'polling',
        expectedRevision,
      });

      if (result.accepted) {
        const receivedAtMs = result.snapshot.timestamps.received_at_ms;
        setData(result.snapshot);
        setClock(Date.now());
        setConnection(previous => ({
          ...previous,
          status: socketOnlineRef.current ? 'online' : 'degraded',
          backend_online: true,
          last_message_at: new Date(receivedAtMs).toISOString(),
          last_message_at_ms: receivedAtMs,
          last_error: socketOnlineRef.current ? null : previous.last_error,
        }));
      } else {
        setConnection(previous => ({
          ...previous,
          backend_online: true,
          rejected_snapshots: previous.rejected_snapshots + 1,
          last_rejection_reason: result.reason,
        }));
      }
    } catch (error) {
      if (!mountedRef.current || (error instanceof ApiError && error.code === 'ABORTED')) return;
      restReachableRef.current = false;
      setConnection(previous => ({
        ...previous,
        status: socketOnlineRef.current ? 'online' : 'offline',
        backend_online: socketOnlineRef.current,
        last_error: toConnectionErrorInfo(error),
      }));
    } finally {
      if (resyncRequestRef.current === controller) resyncRequestRef.current = null;
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    let cancelled = false;
    let reconnectTimer: number | null = null;
    let connectTimer: number | null = null;
    let retryAttempt = 0;
    let openedAtMs: number | null = null;
    let lastStreamMessageAtMs: number | null = null;

    const clearReconnectTimer = () => {
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    };

    const clearConnectTimer = () => {
      if (connectTimer !== null) window.clearTimeout(connectTimer);
      connectTimer = null;
    };

    const recordRejection = (reason: SnapshotRejectionReason) => {
      setConnection(previous => ({
        ...previous,
        rejected_snapshots: previous.rejected_snapshots + 1,
        last_rejection_reason: reason,
      }));
    };

    const acceptMessage = (rawMessage: string) => {
      if (cancelled) return;
      let payload: unknown;
      try {
        payload = JSON.parse(rawMessage) as unknown;
      } catch {
        recordRejection('invalid');
        return;
      }

      const result = gateRef.current.accept(payload, { transport: 'websocket' });
      if (!result.accepted) {
        recordRejection(result.reason);
        return;
      }

      retryAttempt = 0;
      const receivedAtMs = result.snapshot.timestamps.received_at_ms;
      lastStreamMessageAtMs = receivedAtMs;
      setData(result.snapshot);
      setClock(Date.now());
      setConnection(previous => ({
        ...previous,
        status: 'online',
        backend_online: true,
        reconnecting: false,
        attempt: 0,
        connected_at: previous.connected_at ?? new Date(openedAtMs ?? receivedAtMs).toISOString(),
        last_message_at: new Date(receivedAtMs).toISOString(),
        last_message_at_ms: receivedAtMs,
        next_retry_at: null,
        last_error: null,
      }));
    };

    const scheduleReconnect = (error: ConnectionErrorInfo, immediate = false) => {
      if (cancelled || reconnectTimer !== null) return;
      retryAttempt = Math.min(retryAttempt + 1, 10);
      const exponentialCap = Math.min(MAX_RECONNECT_MS, MIN_RECONNECT_MS * 2 ** (retryAttempt - 1));
      // Equal jitter prevents synchronized clients from hammering the backend.
      const delay = immediate ? 0 : Math.round(exponentialCap * (0.5 + Math.random() * 0.5));
      const retryAtMs = Date.now() + delay;
      setConnection(previous => ({
        ...previous,
        status: restReachableRef.current ? 'degraded' : 'reconnecting',
        backend_online: restReachableRef.current,
        reconnecting: true,
        attempt: retryAttempt,
        next_retry_at: new Date(retryAtMs).toISOString(),
        last_error: error,
      }));
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, delay);
      void resync();
    };

    function connect() {
      if (cancelled) return;
      const existing = socketRef.current;
      if (existing?.readyState === WebSocket.OPEN || existing?.readyState === WebSocket.CONNECTING) return;

      clearReconnectTimer();
      setConnection(previous => ({
        ...previous,
        status: retryAttempt > 0 ? 'reconnecting' : 'connecting',
        reconnecting: retryAttempt > 0,
        attempt: retryAttempt,
        next_retry_at: null,
      }));

      try {
        const socket = new WebSocket(SIM_STATE_WS_URL);
        socketRef.current = socket;
        socketOnlineRef.current = false;
        openedAtMs = null;
        lastStreamMessageAtMs = null;

        connectTimer = window.setTimeout(() => {
          if (socket.readyState === WebSocket.CONNECTING) socket.close(4000, 'Connection timeout');
        }, CONNECT_TIMEOUT_MS);

        socket.onopen = () => {
          if (cancelled || socketRef.current !== socket) return;
          clearConnectTimer();
          gateRef.current.beginTransportEpoch();
          socketOnlineRef.current = true;
          openedAtMs = Date.now();
          setConnection(previous => ({
            ...previous,
            status: 'online',
            backend_online: true,
            reconnecting: false,
            attempt: retryAttempt,
            connected_at: previous.connected_at ?? new Date(openedAtMs as number).toISOString(),
            next_retry_at: null,
            last_error: null,
          }));
          void resync();
        };

        socket.onmessage = event => {
          if (cancelled || socketRef.current !== socket) return;
          if (typeof event.data === 'string') {
            acceptMessage(event.data);
          } else if (event.data instanceof Blob) {
            void event.data.text().then(message => {
              if (!cancelled && socketRef.current === socket) acceptMessage(message);
            }).catch(() => recordRejection('invalid'));
          } else {
            recordRejection('invalid');
          }
        };

        socket.onerror = () => {
          if (cancelled || socketRef.current !== socket) return;
          setConnection(previous => ({
            ...previous,
            last_error: websocketError('WEBSOCKET_ERROR', 'Simulation stream encountered a connection error'),
          }));
        };

        socket.onclose = event => {
          if (socketRef.current !== socket) return;
          clearConnectTimer();
          socketRef.current = null;
          socketOnlineRef.current = false;
          openedAtMs = null;
          lastStreamMessageAtMs = null;
          if (cancelled) return;

          const disconnectedAt = new Date().toISOString();
          setConnection(previous => ({
            ...previous,
            status: restReachableRef.current ? 'degraded' : 'offline',
            backend_online: restReachableRef.current,
            reconnecting: true,
            disconnected_at: disconnectedAt,
          }));
          scheduleReconnect(
            websocketError(
              'WEBSOCKET_CLOSED',
              event.reason || `Simulation stream closed (code ${event.code})`,
            ),
          );
        };
      } catch (error) {
        socketRef.current = null;
        socketOnlineRef.current = false;
        scheduleReconnect(websocketError(
          'WEBSOCKET_CONNECT_FAILED',
          error instanceof Error ? error.message : 'Unable to create simulation stream',
        ));
      }
    }

    const handleBrowserOnline = () => {
      clearReconnectTimer();
      retryAttempt = 0;
      connect();
      void resync();
    };

    const handleBrowserOffline = () => {
      restReachableRef.current = false;
      socketOnlineRef.current = false;
      setConnection(previous => ({
        ...previous,
        status: 'offline',
        backend_online: false,
        reconnecting: true,
        disconnected_at: new Date().toISOString(),
        last_error: websocketError('BROWSER_OFFLINE', 'Browser network connection is offline'),
      }));
    };

    const unsubscribe = subscribeToSimSessionInvalidation(event => {
      resyncRequestRef.current?.abort();
      const resetState = gateRef.current.reset(event.session_id ?? undefined);
      lastStreamMessageAtMs = null;
      setData(resetState);
      setClock(Date.now());
      setConnection(previous => ({
        ...previous,
        status: socketOnlineRef.current ? 'online' : 'connecting',
        reconnecting: !socketOnlineRef.current,
        last_message_at: null,
        last_message_at_ms: null,
        last_rejection_reason: null,
      }));
      void resync();
    });

    const watchdogTimer = window.setInterval(() => {
      const now = Date.now();
      setClock(now);
      const socket = socketRef.current;
      if (socket?.readyState !== WebSocket.OPEN) return;
      const activityAt = lastStreamMessageAtMs ?? openedAtMs;
      if (activityAt !== null && now - activityAt > STREAM_SILENCE_TIMEOUT_MS) {
        socket.close(4001, 'Stream stalled');
      }
    }, 1_000);

    window.addEventListener('online', handleBrowserOnline);
    window.addEventListener('offline', handleBrowserOffline);
    void resync();
    connect();

    return () => {
      cancelled = true;
      mountedRef.current = false;
      unsubscribe();
      window.removeEventListener('online', handleBrowserOnline);
      window.removeEventListener('offline', handleBrowserOffline);
      window.clearInterval(watchdogTimer);
      clearReconnectTimer();
      clearConnectTimer();
      resyncRequestRef.current?.abort();
      resyncRequestRef.current = null;
      const socket = socketRef.current;
      socketRef.current = null;
      socketOnlineRef.current = false;
      if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000, 'Component unmounted');
    };
  }, [resync]);

  const dataAgeMs = connection.last_message_at_ms === null
    ? null
    : Math.max(0, clock - connection.last_message_at_ms);
  const dataStale = dataAgeMs === null
    || dataAgeMs > DATA_STALE_AFTER_MS
    || data.quality.stale;

  return {
    ...data,
    data_age_ms: dataAgeMs ?? undefined,
    backendOnline: connection.backend_online,
    reconnecting: connection.reconnecting,
    connection,
    dataAgeMs,
    dataStale,
    lastUpdatedAt: connection.last_message_at,
    resync,
  };
}
