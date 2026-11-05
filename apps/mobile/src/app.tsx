import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { connections } from './connections/native';
import { startPushListeners } from './push/native';
import { useConnections } from './connections/use-connections';
import { ConnectedApp } from './inbox/connected-app';
import { ConnectScreen, type Found } from './screens/connect';
import { SignInScreen } from './screens/sign-in';
import { UpgradeMessage } from './screens/upgrade';
import { Button, Screen, Title, useTheme } from './ui/kit';

function Gate() {
  const { ready, connections: all, activeId } = useConnections();
  const theme = useTheme();
  const [found, setFound] = useState<Found | null>(null);
  const active = all.find((connection) => connection.id === activeId) ?? null;

  useEffect(() => {
    startPushListeners();
    void connections.start();
  }, []);

  // A successful sign-in changes the active connection, which ends the flow that led to it.
  useEffect(() => {
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
  if (!active) return <ConnectScreen onFound={setFound} />;

  if (active.compatibility !== 'compatible') {
    return (
      <Screen key={active.id}>
        <Title>{active.installationName}</Title>
        <UpgradeMessage name={active.installationName} compatibility={active.compatibility} />
        <Button title="Check again" onPress={() => void connections.recheck(active.id)} />
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
        backTitle="Use a different installation"
      />
    );
  }
  // The key is what guarantees that no state from one connection or workspace survives into another.
  return <ConnectedApp key={`${active.id}/${active.workspaceId ?? ''}`} connection={active} />;
}

export function App() {
  return (
    <SafeAreaProvider>
      <StatusBar style="auto" />
      <Gate />
    </SafeAreaProvider>
  );
}
