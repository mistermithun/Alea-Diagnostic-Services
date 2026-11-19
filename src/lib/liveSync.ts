import { getAdminToken, getStaffToken } from './api.ts';

export const LIVE_SYNC_CHANNEL = 'alea_lims_live_sync';

export type LiveSyncMessage =
  | { type: 'PATIENTS_UPDATED'; at: number }
  | { type: 'REQUEST_LAB_TOKEN' }
  | { type: 'LAB_TOKEN_RESPONSE'; token: string; role: 'admin' | 'staff' }
  | { type: 'LAB_SIGNED_OUT' };

function postToChannel(msg: LiveSyncMessage) {
  if (typeof window === 'undefined' || typeof BroadcastChannel === 'undefined') return;
  try {
    const channel = new BroadcastChannel(LIVE_SYNC_CHANNEL);
    channel.postMessage(msg);
    channel.close();
  } catch {
    // ignore channel errors
  }
}

export function broadcastPatientsUpdated() {
  const msg: LiveSyncMessage = { type: 'PATIENTS_UPDATED', at: Date.now() };
  postToChannel(msg);
  if (typeof window !== 'undefined' && window.opener && window.opener !== window) {
    try {
      window.opener.postMessage(msg, window.location.origin);
    } catch {
      // ignore cross-window errors
    }
  }
}

export function broadcastLabSignOut() {
  postToChannel({ type: 'LAB_SIGNED_OUT' });
}

export function sendCurrentLabTokenToTarget(
  targetWindow: Window | null | undefined,
  origin: string
): boolean {
  const adminToken = getAdminToken();
  const staffToken = getStaffToken();
  const payload: LiveSyncMessage | null = adminToken
    ? { type: 'LAB_TOKEN_RESPONSE', token: adminToken, role: 'admin' }
    : staffToken
      ? { type: 'LAB_TOKEN_RESPONSE', token: staffToken, role: 'staff' }
      : null;
  if (!payload) return false;

  if (targetWindow && typeof targetWindow.postMessage === 'function') {
    try {
      targetWindow.postMessage(payload, origin);
    } catch {
      // ignore postMessage errors
    }
  }
  postToChannel(payload);
  return true;
}

export function attachLabTokenResponder(): () => void {
  if (typeof window === 'undefined') return () => {};

  const onWindowMessage = (event: MessageEvent) => {
    if (event.origin !== window.location.origin) return;
    const data = event.data as Partial<LiveSyncMessage> | null;
    if (data?.type === 'REQUEST_LAB_TOKEN') {
      sendCurrentLabTokenToTarget(
        event.source as Window | null | undefined,
        event.origin
      );
    }
  };

  window.addEventListener('message', onWindowMessage);

  let channel: BroadcastChannel | null = null;
  if (typeof BroadcastChannel !== 'undefined') {
    try {
      channel = new BroadcastChannel(LIVE_SYNC_CHANNEL);
      channel.onmessage = (event) => {
        const data = event.data as Partial<LiveSyncMessage> | null;
        if (data?.type === 'REQUEST_LAB_TOKEN') {
          sendCurrentLabTokenToTarget(null, window.location.origin);
        }
      };
    } catch {
      channel = null;
    }
  }

  return () => {
    window.removeEventListener('message', onWindowMessage);
    channel?.close();
  };
}

export function requestLabTokenFromParent(timeoutMs = 500): Promise<{
  token: string;
  role: 'admin' | 'staff';
} | null> {
  if (typeof window === 'undefined') return Promise.resolve(null);

  return new Promise((resolve) => {
    let settled = false;
    let channel: BroadcastChannel | null = null;
    let timer: number | undefined;

    const cleanup = () => {
      if (timer !== undefined) window.clearTimeout(timer);
      window.removeEventListener('message', onWindowMessage);
      channel?.close();
    };

    const finish = (result: { token: string; role: 'admin' | 'staff' } | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const handlePayload = (data: Partial<LiveSyncMessage> | null) => {
      if (
        data?.type === 'LAB_TOKEN_RESPONSE' &&
        typeof data.token === 'string' &&
        data.token.length > 0 &&
        (data.role === 'admin' || data.role === 'staff')
      ) {
        finish({ token: data.token, role: data.role });
      }
    };

    const onWindowMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      handlePayload(event.data as Partial<LiveSyncMessage> | null);
    };

    window.addEventListener('message', onWindowMessage);

    if (typeof BroadcastChannel !== 'undefined') {
      try {
        channel = new BroadcastChannel(LIVE_SYNC_CHANNEL);
        channel.onmessage = (event) => {
          handlePayload(event.data as Partial<LiveSyncMessage> | null);
        };
        channel.postMessage({ type: 'REQUEST_LAB_TOKEN' } satisfies LiveSyncMessage);
      } catch {
        channel = null;
      }
    }

    if (window.opener && window.opener !== window) {
      try {
        window.opener.postMessage(
          { type: 'REQUEST_LAB_TOKEN' } satisfies LiveSyncMessage,
          window.location.origin
        );
      } catch {
        // ignore opener cross-origin error
      }
    }

    timer = window.setTimeout(() => finish(null), timeoutMs);
  });
}
