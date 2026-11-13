import { useState, type FormEvent, type ReactNode } from 'react';
import { api, errorMessage, session } from '../app-context';
import { SoftwareFooter } from '../software-footer';

const go = (path: string) => window.location.assign(path);

function Frame({ title, children }: { title: string; children: ReactNode }) {
  return (
    // The footer is outside main, so that it is the page's contentinfo landmark.
    <div className="min-h-dvh bg-linear-to-b from-brand-50 via-slate-50 to-slate-50 px-4 pt-16 pb-6 dark:from-slate-900 dark:via-slate-950 dark:to-slate-950">
      <div className="mx-auto max-w-sm">
        <main>
          <div className="mb-6 flex flex-col items-center text-center">
            <img className="mb-4 size-20" src="/brand/mark-256.png" width={80} height={80} alt="" />
            <h1 className="text-2xl font-semibold tracking-tight">OpenChat</h1>
            <h2 className="mt-1 text-sm text-slate-600 dark:text-slate-400">{title}</h2>
          </div>
          <div className="card space-y-4 p-6 shadow-lg shadow-brand-900/5">{children}</div>
        </main>
        <SoftwareFooter />
      </div>
    </div>
  );
}

function Field(props: { label: string; type?: string; value: string; onChange: (value: string) => void; autoComplete: string; minLength?: number; maxLength?: number }) {
  return (
    <label className="block text-sm font-medium">
      {props.label}
      <input
        className="field mt-1 font-normal"
        type={props.type ?? 'text'}
        value={props.value}
        required
        autoComplete={props.autoComplete}
        {...(props.minLength ? { minLength: props.minLength } : {})}
        {...(props.maxLength ? { maxLength: props.maxLength } : {})}
        onChange={(event) => props.onChange(event.target.value)}
      />
    </label>
  );
}

/** Runs one submission at a time, and shows its failure. */
function useSubmit() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = (action: () => Promise<void>) => async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

export function SignInPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const { busy, error, run } = useSubmit();
  return (
    <Frame title="Sign in to your team inbox">
      <form
        className="space-y-4"
        onSubmit={run(async () => {
          const tokens = await api.login({ email, password, clientType: 'dashboard', clientLabel: 'Dashboard' });
          session.signedIn(tokens.accessToken, tokens.accessTokenExpiresAt);
        })}
      >
        <Field label="Email" type="email" value={email} onChange={setEmail} autoComplete="username" />
        <Field label="Password" type="password" value={password} onChange={setPassword} autoComplete="current-password" maxLength={1024} />
        {error && <p className="error" role="alert">{error}</p>}
        <button className="button w-full" disabled={busy}>Sign in</button>
      </form>
      <a className="block text-sm link" href="/forgot-password">Forgot your password?</a>
    </Frame>
  );
}

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const { busy, error, run } = useSubmit();
  return (
    <Frame title="Reset your password">
      {sent ? (
        <p className="notice" role="status">If that address has an account, a reset link is on its way. It expires in one hour.</p>
      ) : (
        <form
          className="space-y-4"
          onSubmit={run(async () => {
            await api.requestPasswordReset(email);
            setSent(true);
          })}
        >
          <Field label="Email" type="email" value={email} onChange={setEmail} autoComplete="username" />
          {error && <p className="error" role="alert">{error}</p>}
          <button className="button w-full" disabled={busy}>Send reset link</button>
        </form>
      )}
      <a className="block text-sm link" href="/">Back to sign in</a>
    </Frame>
  );
}

export function ResetPasswordPage({ token }: { token: string | null }) {
  const [password, setPassword] = useState('');
  const [done, setDone] = useState(false);
  const { busy, error, run } = useSubmit();
  if (!token) {
    return (
      <Frame title="Reset your password">
        <p className="error" role="alert">This link is incomplete. Request a new one.</p>
        <a className="block text-sm link" href="/forgot-password">Request a new link</a>
      </Frame>
    );
  }
  return (
    <Frame title="Choose a new password">
      {done ? (
        <>
          <p className="notice" role="status">Your password has changed, and all your devices have been signed out.</p>
          <button className="button w-full" onClick={() => go('/')}>Sign in</button>
        </>
      ) : (
        <form
          className="space-y-4"
          onSubmit={run(async () => {
            await api.confirmPasswordReset(token, password);
            setDone(true);
          })}
        >
          <Field label="New password" type="password" value={password} onChange={setPassword} autoComplete="new-password" minLength={10} maxLength={1024} />
          {error && <p className="error" role="alert">{error}</p>}
          <button className="button w-full" disabled={busy}>Change password</button>
        </form>
      )}
    </Frame>
  );
}
