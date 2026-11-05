import { ApiError, type Me } from '@openchat/api-client';
import { useEffect, useState } from 'react';
import type { ConnectionView } from '../connections/manager';
import { connections } from '../connections/native';
import { useConnections } from '../connections/use-connections';
import { Body, Button, Problem, Screen, Title } from '../ui/kit';

/** Stands in for the inbox, which is the next slice. Rendered with a `key`, so nothing survives a switch. */
export function HomeScreen({ connection, onAdd }: { connection: ConnectionView; onAdd: () => void }) {
  const [me, setMe] = useState<Me | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const { connections: all } = useConnections();

  useEffect(() => {
    let live = true;
    connections
      .session(connection.id)
      .client.getMe()
      .then((value) => {
        if (live) setMe(value);
      })
      .catch((error: unknown) => {
        if (live && !(error instanceof ApiError && error.status === 401)) setProblem('Could not load your workspaces. Check your connection.');
      });
    return () => {
      live = false;
    };
  }, [connection.id]);

  return (
    <Screen>
      <Title>{connection.installationName}</Title>
      <Body muted>Signed in as {connection.email}</Body>
      {problem && <Problem>{problem}</Problem>}
      {me?.memberships.map(({ workspace }) => (
        <Button key={workspace.id} title={`${workspace.name}${workspace.id === connection.workspaceId ? ' (selected)' : ''}`} kind="plain" onPress={() => void connections.selectWorkspace(connection.id, workspace.id)} />
      ))}
      {all
        .filter((other) => other.id !== connection.id)
        .map((other) => (
          <Button key={other.id} title={`Switch to ${other.installationName}`} kind="plain" onPress={() => void connections.switchTo(other.id)} />
        ))}
      <Button title="Add an installation" kind="plain" onPress={onAdd} />
      <Button title="Sign out" kind="danger" onPress={() => void connections.signOut(connection.id)} />
    </Screen>
  );
}
