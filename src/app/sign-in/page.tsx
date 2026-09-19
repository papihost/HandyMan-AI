'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api } from '../../client/api';
import { deviceId } from '../../client/outbox';

export default function SignInPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const { user } = await api.signIn(email, password, await deviceId());
      // Where someone lands is decided by what they are. A controller signing in on a
      // laptop wants the books; a technician signing in on a tablet wants their day.
      router.replace(user.technicianId ? '/field' : '/office');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not sign in');
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-6 px-6">
      <div>
        <h1 className="text-3xl font-bold">Apex Field</h1>
        <p className="mt-1 text-[var(--color-ink-soft)]">
          Technicians get their day. Everyone else gets the office.
        </p>
      </div>

      <form onSubmit={submit} className="card space-y-4 p-5">
        <label className="block space-y-1.5">
          <span className="text-sm font-medium text-[var(--color-ink-soft)]">Email</span>
          <input
            type="email"
            inputMode="email"
            autoComplete="username"
            autoCapitalize="none"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="field-input"
          />
        </label>

        <label className="block space-y-1.5">
          <span className="text-sm font-medium text-[var(--color-ink-soft)]">Password</span>
          <input
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="field-input"
          />
        </label>

        {error && (
          <p role="alert" className="text-sm font-medium text-[var(--color-stop)]">
            {error}
          </p>
        )}

        <button type="submit" disabled={busy} className="btn btn-primary w-full disabled:opacity-60">
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </main>
  );
}
