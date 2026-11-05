import { connections } from '../connections/native';
import { useConnections } from '../connections/use-connections';
import { Body, Button, Screen, Title } from '../ui/kit';
import { useWorkspace } from './connected-app';

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
      <Button title="Sign out" kind="danger" onPress={() => void connections.signOut(connection.id)} />
    </Screen>
  );
}
