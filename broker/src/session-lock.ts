// Keeps an OAuth account's requests on its own credential, whatever else the broker's environment could supply.
import {
	type AuthCredential,
	type AuthStorage,
	resolveCredentialIdentityKey,
	type SessionRestrictionLease,
} from "@oh-my-pi/pi-ai";
import type { Account } from "./accounts.ts";

interface Lock {
	lease: SessionRestrictionLease;
	count: number;
}

/**
 * Holds `sessionId` on one OAuth account while requests of that session are in flight.
 *
 * Problem: when an account's OAuth credential cannot serve (blocked after a usage limit, refresh failed), OMP's key
 * cascade moves on to the next source for the session: an `ANTHROPIC_API_KEY` in the broker's environment. A
 * subscription request would then be billed to a key the user never chose.
 * Solution: `sessions.restrict` limits the session to that account's identity, and OMP fails the request instead. It
 * must be the exact session id OMP resolves credentials under, which for pi-native requests is `options.sessionId`.
 * API-key accounts need no lock: their key is a runtime override, which the cascade reads first.
 */
export class SessionLocks {
	private readonly held = new WeakMap<AuthStorage, Map<string, Lock>>();

	/** Locks the session to the account's credential, shared by concurrent requests; returns the release. */
	hold(account: Account, credential: AuthCredential, sessionId: string): () => void {
		if (credential.type !== "oauth") return () => {};
		const { storage, provider } = account;
		const locks = this.held.get(storage) ?? new Map<string, Lock>();
		this.held.set(storage, locks);
		const existing = locks.get(sessionId);
		if (existing) existing.count++;
		else {
			const identity = resolveCredentialIdentityKey(provider, credential);
			// An unnamed identity allows nothing: the request fails rather than borrow another credential.
			locks.set(sessionId, {
				lease: storage.sessions.restrict(provider, sessionId, identity ? [identity] : []),
				count: 1,
			});
		}
		let released = false;
		return () => {
			if (released) return;
			released = true;
			const lock = locks.get(sessionId)!;
			if (--lock.count > 0) return;
			locks.delete(sessionId);
			storage.sessions.unrestrict(provider, sessionId, lock.lease);
		};
	}
}
