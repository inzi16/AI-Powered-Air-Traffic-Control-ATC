import { useCallback, useEffect, useRef, useState } from 'react';

interface InstallChoice {
  outcome: 'accepted' | 'dismissed';
  platform: string;
}

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<InstallChoice>;
}

interface NavigatorWithStandalone extends Navigator {
  standalone?: boolean;
}

export interface PWAController {
  online: boolean;
  canInstall: boolean;
  updateAvailable: boolean;
  applying: boolean;
  serviceWorkerSupported: boolean;
  install: () => Promise<void>;
  applyUpdate: () => Promise<void>;
}

function isStandaloneDisplay(): boolean {
  return window.matchMedia('(display-mode: standalone)').matches
    || Boolean((navigator as NavigatorWithStandalone).standalone);
}

export function usePWA(): PWAController {
  const serviceWorkerSupported = import.meta.env.PROD && 'serviceWorker' in navigator;
  const [online, setOnline] = useState(() => navigator.onLine);
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [applying, setApplying] = useState(false);
  const registrationRef = useRef<ServiceWorkerRegistration | null>(null);
  const reloadOnControllerChangeRef = useRef(false);

  useEffect(() => {
    const handleOnline = () => setOnline(true);
    const handleOffline = () => setOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  useEffect(() => {
    if (!serviceWorkerSupported || isStandaloneDisplay()) return;
    const handleInstallPrompt = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as BeforeInstallPromptEvent);
    };
    const handleInstalled = () => setInstallPrompt(null);
    window.addEventListener('beforeinstallprompt', handleInstallPrompt);
    window.addEventListener('appinstalled', handleInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', handleInstallPrompt);
      window.removeEventListener('appinstalled', handleInstalled);
    };
  }, [serviceWorkerSupported]);

  useEffect(() => {
    if (!serviceWorkerSupported) return;
    let cancelled = false;

    const inspectRegistration = (registration: ServiceWorkerRegistration) => {
      if (cancelled) return;
      registrationRef.current = registration;
      setUpdateAvailable(Boolean(registration.waiting));
      registration.addEventListener('updatefound', () => {
        const installing = registration.installing;
        if (!installing) return;
        installing.addEventListener('statechange', () => {
          if (!cancelled && installing.state === 'installed' && navigator.serviceWorker.controller) {
            setUpdateAvailable(true);
          }
        });
      });
    };

    const handleControllerChange = () => {
      if (!reloadOnControllerChangeRef.current) return;
      reloadOnControllerChangeRef.current = false;
      window.location.reload();
    };

    navigator.serviceWorker.addEventListener('controllerchange', handleControllerChange);
    void navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' })
      .then(inspectRegistration)
      .catch(() => undefined);

    const checkForUpdate = () => {
      if (document.visibilityState === 'visible') void registrationRef.current?.update().catch(() => undefined);
    };
    document.addEventListener('visibilitychange', checkForUpdate);
    const updateTimer = window.setInterval(checkForUpdate, 60 * 60 * 1_000);

    return () => {
      cancelled = true;
      window.clearInterval(updateTimer);
      document.removeEventListener('visibilitychange', checkForUpdate);
      navigator.serviceWorker.removeEventListener('controllerchange', handleControllerChange);
    };
  }, [serviceWorkerSupported]);

  const install = useCallback(async () => {
    if (!installPrompt) return;
    setApplying(true);
    try {
      await installPrompt.prompt();
      await installPrompt.userChoice;
      setInstallPrompt(null);
    } finally {
      setApplying(false);
    }
  }, [installPrompt]);

  const applyUpdate = useCallback(async () => {
    const registration = registrationRef.current;
    if (!registration) return;
    setApplying(true);
    try {
      if (!registration.waiting) await registration.update();
      const waiting = registration.waiting;
      if (!waiting) return;
      reloadOnControllerChangeRef.current = true;
      waiting.postMessage({ type: 'SKIP_WAITING' });
    } finally {
      setApplying(false);
    }
  }, []);

  return {
    online,
    canInstall: Boolean(installPrompt) && !isStandaloneDisplay(),
    updateAvailable,
    applying,
    serviceWorkerSupported,
    install,
    applyUpdate,
  };
}
