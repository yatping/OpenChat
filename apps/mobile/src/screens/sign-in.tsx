import { createClient, type DiscoveryResponse } from '@openchat/api-client';
import { useState } from 'react';
import { connections } from '../connections/native';
import type { SignInError } from '../connections/manager';
import { Body, Button, Field, Problem, Screen, Title } from '../ui/kit';

const MESSAGES: Record<SignInError, string> = {
  wrong_credentials: 'That email and password do not match.',
  rate_limited: 'Too many attempts. Please wait a while and try again.',
  unreachable: 'The installation could not be reached. Check your connection, then try again.',
  failed: 'Signing in did not work. Please try again.',
};

interface Props {
  baseUrl: string;
  discovery: DiscoveryResponse;
  email?: string;
  notice?: string;
  onBack?: () => void;
  backTitle?: string;
}

export function SignInScreen({ baseUrl, discovery, email: knownEmail, notice, onBack, backTitle }: Props) {
  const [email, setEmail] = useState(knownEmail ?? '');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<SignInError | null>(null);
  const [resetSent, setResetSent] = useState(false);

  const submit = async () => {
    setProblem(null);
    setBusy(true);
    const result = await connections.signIn(baseUrl, discovery, { email: email.trim(), password });
    setBusy(false);
    if (!result.ok) setProblem(result.reason);
  };

  const reset = async () => {
    setProblem(null);
    setBusy(true);
    await createClient({ baseUrl }).requestPasswordReset(email.trim()).catch(() => undefined);
    setBusy(false);
    setResetSent(true);
  };

  return (
    <Screen>
      <Title>{discovery.name}</Title>
      <Body muted>{baseUrl.replace(/^https?:\/\//, '')}</Body>
      {notice && <Body>{notice}</Body>}
      <Field label="Email" value={email} onChangeText={setEmail} keyboardType="email-address" textContentType="username" autoComplete="email" />
      <Field label="Password" value={password} onChangeText={setPassword} secureTextEntry textContentType="password" autoComplete="current-password" returnKeyType="go" onSubmitEditing={() => void submit()} />
      {problem && <Problem>{MESSAGES[problem]}</Problem>}
      {resetSent && <Body>If that account exists, a link to set a new password is on its way.</Body>}
      <Button title="Sign in" busy={busy} disabled={!email.trim() || !password} onPress={() => void submit()} />
      <Button title="Forgot password" kind="plain" disabled={busy || !email.trim()} onPress={() => void reset()} />
      {onBack && <Button title={backTitle ?? 'Back'} kind="plain" onPress={onBack} />}
    </Screen>
  );
}
