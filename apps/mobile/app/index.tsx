import { useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { connections } from '../src/connections/native';
import { useConnections } from '../src/connections/use-connections';
import { ConnectScreen, type Found } from '../src/screens/connect';
import { HomeScreen } from '../src/screens/home';
import { SignInScreen } from '../src/screens/sign-in';
import { UpgradeMessage } from '../src/screens/upgrade';
import { Button, Screen, Title, useTheme } from '../src/ui/kit';

export default function Index() {
  const { ready, connections: all, activeId } = useConnections();
  const theme = useTheme();
  const [adding, setAdding] = useState(false);
  const [found, setFound] = useState<Found | null>(null);
  const active = all.find((connection) => connection.id === activeId) ?? null;

  // A successful sign-in changes the active connection, which ends the flow that led to it.
  useEffect(() => {
    setAdding(false);
    setFound(null);
  }, [activeId]);

  if (!ready) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.background }}>
        <ActivityIndicator accessibilityLabel="Loading" />
      </View>
    );
  }
  if (found) return <SignInScreen baseUrl={found.baseUrl} discovery={found.discovery} onBack={() => setFound(null)} />;
  if (adding || !active) return <ConnectScreen onFound={setFound} {...(adding && active ? { onCancel: () => setAdding(false) } : {})} />;

  if (active.compatibility !== 'compatible') {
    return (
      <Screen key={active.id}>
        <Title>{active.installationName}</Title>
        <UpgradeMessage name={active.installationName} compatibility={active.compatibility} />
        <Button title="Check again" onPress={() => void connections.recheck(active.id)} />
        <Button title="Add an installation" kind="plain" onPress={() => setAdding(true)} />
        <Button title="Sign out" kind="danger" onPress={() => void connections.signOut(active.id)} />
      </Screen>
    );
  }
  if (active.expired) {
    return (
      <SignInScreen
        key={active.id}
        baseUrl={active.baseUrl}
        discovery={{ installationId: active.installationId, name: active.installationName, api: { versions: ['v1'], minor: 0 }, realtime: { protocolVersions: [] }, relay: null, auth: { signup: 'invite_only' } }}
        email={active.email}
        notice="Your session has ended. Please sign in again."
        onBack={() => void connections.remove(active.id)}
        backTitle="Remove this installation"
      />
    );
  }
  // The key is what guarantees that no state from one connection survives into another.
  return <HomeScreen key={active.id} connection={active} onAdd={() => setAdding(true)} />;
}
