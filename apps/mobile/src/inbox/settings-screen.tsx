import type { NotificationPreferences } from '@openchat/api-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import { Linking, Switch, Text, View } from 'react-native';
import { connections } from '../connections/native';
import { pushRegistrar } from '../push/native';
import type { PushStatus } from '../push/registrar';
import { Body, Button, Problem, Screen, Title, useTheme } from '../ui/kit';
import { useWorkspace } from './connected-app';

/** Only events that something sends. The rest join here when they do. */
const CHOICES = [
  { eventType: 'new_conversation', label: 'New conversations' },
  { eventType: 'new_message', label: 'New messages' },
  { eventType: 'conversation_assigned', label: 'Assigned to you' },
] as const;

const STATUS_TEXT: Record<Exclude<PushStatus, 'on' | 'off'>, string> = {
  not_allowed: 'This installation uses a notification service this app cannot use. Messages still arrive in the inbox.',
  denied: 'Notifications are turned off for this app in iOS Settings.',
  failed: 'This device could not be registered for notifications. It will try again the next time the app starts.',
};

function NotificationSettings() {
  const { api, workspaceId } = useWorkspace();
  const theme = useTheme();
  const client = useQueryClient();
  const status = useSyncExternalStore(pushRegistrar.subscribe, pushRegistrar.getStatus);
  const key = ['notification-preferences', workspaceId];
  const preferences = useQuery({ queryKey: key, queryFn: () => api.getNotificationPreferences(workspaceId), enabled: status === 'on' });
  const save = useMutation({
    mutationFn: (next: NotificationPreferences) => api.setNotificationPreferences(workspaceId, next),
    onMutate: (next) => client.setQueryData(key, next),
    onError: () => client.invalidateQueries({ queryKey: key }),
  });
  if (status === 'off') return null;
  if (status !== 'on') {
    return (
      <>
        <Body>Notifications</Body>
        <Body muted>{STATUS_TEXT[status]}</Body>
        {status === 'denied' && <Button title="Open iOS Settings" kind="plain" onPress={() => void Linking.openSettings()} />}
      </>
    );
  }
  const toggle = (eventType: (typeof CHOICES)[number]['eventType'], enabled: boolean) => {
    const others = (preferences.data?.preferences ?? []).filter((p) => p.eventType !== eventType);
    save.mutate({ preferences: [...others, { eventType, channel: 'push', enabled }] });
  };
  return (
    <>
      <Body>Notifications</Body>
      {CHOICES.map(({ eventType, label }) => (
        <View key={eventType} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 44 }}>
          <Text style={{ color: theme.text, fontSize: 16 }}>{label}</Text>
          <Switch
            accessibilityLabel={label}
            disabled={!preferences.data}
            value={preferences.data?.preferences.find((p) => p.eventType === eventType)?.enabled ?? true}
            onValueChange={(enabled) => toggle(eventType, enabled)}
          />
        </View>
      ))}
      {save.error && <Problem>Could not save that. Check your connection and try again.</Problem>}
    </>
  );
}

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
      <NotificationSettings />
      <Button title="Sign out" kind="danger" onPress={() => void connections.signOut(connection.id)} />
    </Screen>
  );
}
