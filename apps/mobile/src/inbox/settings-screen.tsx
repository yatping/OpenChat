import { ApiError } from '@openchat/api-client';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { Alert } from 'react-native';
import { connections } from '../connections/native';
import { useConnections } from '../connections/use-connections';
import { Body, Button, Field, Problem, Screen, Title } from '../ui/kit';
import { useWorkspace } from './connected-app';

function deleteProblem(error: unknown): string {
  if (!(error instanceof ApiError)) return 'That did not work. Check your connection, then try again.';
  if (error.status === 403) return 'That password is not right.';
  if (error.status === 409) return 'You are the only owner of a workspace. Make someone else an owner first, then try again.';
  if (error.status === 429) return 'Too many attempts. Please wait a while and try again.';
  return 'That did not work. Please try again.';
}

function DeleteAccount() {
  const { api, connection } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const remove = useMutation({
    mutationFn: () => api.deleteAccount(password),
    // The account has gone, so there is nothing left to sign out of. This device forgets it too.
    onSuccess: () => connections.remove(connection.id),
    onError: () => setPassword(''),
  });
  if (!open) return <Button title="Delete my account" kind="danger" onPress={() => setOpen(true)} />;
  const confirm = () =>
    Alert.alert('Delete your account?', `This removes you from every workspace on ${connection.installationName}, and it cannot be undone.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => remove.mutate() },
    ]);
  return (
    <>
      <Body>Deleting your account removes your name and email from {connection.installationName}, and takes you out of every workspace. Messages you sent stay in their conversations, without your name.</Body>
      <Field label="Your password" value={password} onChangeText={setPassword} secureTextEntry textContentType="password" autoComplete="current-password" />
      {remove.error && <Problem>{deleteProblem(remove.error)}</Problem>}
      <Button title="Delete my account" kind="danger" busy={remove.isPending} disabled={!password} onPress={confirm} />
      <Button title="Keep my account" kind="plain" onPress={() => { setOpen(false); setPassword(''); remove.reset(); }} />
    </>
  );
}

export function SettingsScreen() {
  const { connection, me, workspaceId, onAdd } = useWorkspace();
  const { connections: all } = useConnections();
  return (
    <Screen>
      <Title>{connection.installationName}</Title>
      <Body>{me.name}</Body>
      <Body muted>Signed in as {me.email}</Body>
      {me.memberships.length > 1 && <Body>Workspaces</Body>}
      {me.memberships.length > 1 &&
        me.memberships.map(({ workspace }) => (
          <Button key={workspace.id} title={`${workspace.name}${workspace.id === workspaceId ? ' (selected)' : ''}`} kind="plain" onPress={() => void connections.selectWorkspace(connection.id, workspace.id)} />
        ))}
      {all.length > 1 && <Body>Other installations</Body>}
      {all
        .filter((other) => other.id !== connection.id)
        .map((other) => (
          <Button key={other.id} title={`Switch to ${other.installationName} (${other.email})`} kind="plain" onPress={() => void connections.switchTo(other.id)} />
        ))}
      <Button title="Add an installation" kind="plain" onPress={onAdd} />
      <Button title="Sign out" kind="plain" onPress={() => void connections.signOut(connection.id)} />
      <DeleteAccount />
    </Screen>
  );
}
