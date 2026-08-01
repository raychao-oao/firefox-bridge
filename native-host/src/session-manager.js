import { randomUUID } from 'node:crypto';

export class SessionManager {
  constructor() {
    this.sessions = new Set(); // session ids known to be alive
    this.leases = new Map(); // tabId -> sessionId
  }

  createSession() {
    const id = randomUUID();
    this.sessions.add(id);
    return id;
  }

  destroySession(sessionId) {
    this.sessions.delete(sessionId);
    for (const [tabId, owner] of this.leases) {
      if (owner === sessionId) this.leases.delete(tabId);
    }
  }

  acquireLease(sessionId, tabId) {
    if (!this.sessions.has(sessionId)) {
      return { ok: false, error: 'unknown_session' };
    }
    const currentOwner = this.leases.get(tabId);
    if (currentOwner && currentOwner !== sessionId) {
      return { ok: false, error: 'conflict' };
    }
    this.leases.set(tabId, sessionId);
    return { ok: true };
  }

  releaseLease(sessionId, tabId) {
    if (this.leases.get(tabId) === sessionId) {
      this.leases.delete(tabId);
    }
  }

  isLeaseOwner(sessionId, tabId) {
    return this.leases.get(tabId) === sessionId;
  }

  leaseOwner(tabId) {
    return this.leases.get(tabId) ?? null;
  }

  invalidateLeasesForTab(tabId) {
    this.leases.delete(tabId);
  }
}
