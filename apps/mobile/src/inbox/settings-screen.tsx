import { connections } from '../connections/native';
import { Body, Button, Screen, Title } from '../ui/kit';
import { useWorkspace } from './connected-app';

export function SettingsScreen() {
  const { connection, me, workspaceId } = useWorkspace();
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
      <Button title="Sign out" kind="danger" onPress={() => void connections.signOut(connection.id)} />
    </Screen>
  );
}
