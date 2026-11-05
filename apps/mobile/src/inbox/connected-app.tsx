/**
 * Everything that belongs to one connection and workspace. It is mounted with a key, so switching replaces all of
 * it, including the query cache, the socket, and the navigation stack. Nothing has to remember to filter.
 */
import { ApiError, type ApiClient, type Me } from '@openchat/api-client';
import { DarkTheme, DefaultTheme, NavigationContainer, NavigationIndependentTree } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useColorScheme } from 'react-native';
import type { ConnectionView } from '../connections/manager';
import { connections } from '../connections/native';
import { Body, Button, Problem, Screen, Title } from '../ui/kit';
import { createInboxCache, type InboxCache } from './cache';
import { ConversationScreen } from './conversation-screen';
import { InboxScreen } from './inbox-screen';
import { useLive } from './live';
import { SettingsScreen } from './settings-screen';

export type Routes = {
  Inbox: undefined;
  Conversation: { conversationId: string };
  Settings: undefined;
};

const Stack = createNativeStackNavigator<Routes>();

export interface WorkspaceScope {
  api: ApiClient;
  connection: ConnectionView;
  workspaceId: string;
  me: Me;
  memberId: string;
  cache: InboxCache;
  live: ReturnType<typeof useLive>;
  openConversation: RefObject<string | null>;
  onAdd: () => void;
}

const Scope = createContext<WorkspaceScope | null>(null);

export function useWorkspace(): WorkspaceScope {
  const scope = useContext(Scope);
  if (!scope) throw new Error('Outside a workspace');
  return scope;
}

function Workspace({ connection, workspaceId, me, api, onAdd, client }: { connection: ConnectionView; workspaceId: string; me: Me; api: ApiClient; onAdd: () => void; client: QueryClient }) {
  const scheme = useColorScheme();
  const cache = useMemo(() => createInboxCache(client, api, workspaceId), [api, client, workspaceId]);
  const openConversation = useRef<string | null>(null);
  const live = useLive(api, workspaceId, cache, openConversation);
  const membership = me.memberships.find((candidate) => candidate.workspace.id === workspaceId)!;
  const scope: WorkspaceScope = { api, connection, workspaceId, me, memberId: membership.memberId, cache, live, openConversation, onAdd };
  return (
    <Scope.Provider value={scope}>
      <NavigationIndependentTree>
        <NavigationContainer theme={scheme === 'dark' ? DarkTheme : DefaultTheme}>
          <Stack.Navigator>
            <Stack.Screen name="Inbox" component={InboxScreen} options={{ title: membership.workspace.name }} />
            <Stack.Screen name="Conversation" component={ConversationScreen} options={{ title: '' }} />
            <Stack.Screen name="Settings" component={SettingsScreen} />
          </Stack.Navigator>
        </NavigationContainer>
      </NavigationIndependentTree>
    </Scope.Provider>
  );
}

function Loaded({ connection, api, onAdd, client }: { connection: ConnectionView; api: ApiClient; onAdd: () => void; client: QueryClient }) {
  const me = useQuery({ queryKey: ['me'], queryFn: () => api.getMe() });
  const memberships = me.data?.memberships;
  const held = memberships?.some((membership) => membership.workspace.id === connection.workspaceId) ?? false;

  // Access can be removed at any time. Move to a workspace that is still held, which remounts all of this.
  useEffect(() => {
    if (memberships && !held && memberships[0]) void connections.selectWorkspace(connection.id, memberships[0].workspace.id);
  }, [connection.id, held, memberships]);

  if (me.data && held) return <Workspace connection={connection} workspaceId={connection.workspaceId!} me={me.data} api={api} onAdd={onAdd} client={client} />;

  const signOut = <Button title="Sign out" kind="danger" onPress={() => void connections.signOut(connection.id)} />;
  if (me.error && !(me.error instanceof ApiError && me.error.status === 401)) {
    return (
      <Screen>
        <Title>{connection.installationName}</Title>
        <Problem>Could not load your account. Check your connection and try again.</Problem>
        <Button title="Try again" onPress={() => void me.refetch()} />
        <Button title="Add an installation" kind="plain" onPress={onAdd} />
        {signOut}
      </Screen>
    );
  }
  return (
    <Screen>
      <Title>{connection.installationName}</Title>
      {memberships?.length === 0 ? <Body>You are not in a workspace on this installation yet. Ask its administrator to invite you.</Body> : <Body muted>Loading…</Body>}
      {memberships?.length === 0 && signOut}
    </Screen>
  );
}

export function ConnectedApp({ connection, onAdd }: { connection: ConnectionView; onAdd: () => void }) {
  const api = connections.session(connection.id).client;
  // One per Connection and workspace, never shared, so cached data has nowhere to leak from.
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 10_000, retry: (count, error) => !(error instanceof ApiError && error.status < 500) && count < 2 },
        },
      }),
  );
  useEffect(() => () => client.clear(), [client]);
  return (
    <QueryClientProvider client={client}>
      <Loaded connection={connection} api={api} onAdd={onAdd} client={client} />
    </QueryClientProvider>
  );
}
