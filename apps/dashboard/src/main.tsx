import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode, useEffect, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { preference, queryClient, session } from './app-context';
import { LANGUAGE_PREFERENCE, startLocale, t } from './i18n';
import { ForgotPasswordPage, ResetPasswordPage, SignInPage } from './pages/account-pages';
import { WorkspaceApp } from './pages/workspace-pages';
import { takeTokenFromUrl } from './session';
import './styles.css';

startLocale(preference.get(LANGUAGE_PREFERENCE), navigator.languages ?? [navigator.language]);

const path = window.location.pathname;
// Taken once at load, before anything renders, so that the token leaves the address bar at once.
const urlToken = path === '/reset-password' ? takeTokenFromUrl(window.location, window.history) : null;

function SignedInOrOut() {
  const signedIn = useSyncExternalStore(session.subscribe, session.isSignedIn);
  const [checking, setChecking] = useState(true);
  useEffect(() => {
    // The cookie may hold a session from an earlier visit.
    void session.refresh().finally(() => setChecking(false));
  }, []);
  if (signedIn) return <WorkspaceApp />;
  if (checking) return <p className="p-6 text-sm" role="status">{t('loading')}</p>;
  return path === '/forgot-password' ? <ForgotPasswordPage /> : <SignInPage />;
}

function App() {
  if (path === '/reset-password') return <ResetPasswordPage token={urlToken} />;
  return <SignedInOrOut />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
