import { useQuery } from '@tanstack/react-query';
import Constants from 'expo-constants';
import { useState } from 'react';
import { Linking, Pressable, Text, View } from 'react-native';
import { useWorkspace } from '../inbox/connected-app';
import { Body, Button, Screen, Title, useTheme } from '../ui/kit';
import licenses from './third-party-licenses.json';

const PROJECT = 'https://github.com/yatping/OpenChat';

interface License {
  name: string;
  version: string;
  license: string;
  text: string;
}

function Package({ entry }: { entry: License }) {
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  return (
    <View style={{ borderTopWidth: 1, borderTopColor: theme.border, paddingVertical: 10 }}>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} accessibilityHint="Shows the licence text" onPress={() => setOpen(!open)} style={{ minHeight: 44, justifyContent: 'center' }}>
        <Text style={{ color: theme.text, fontSize: 16 }}>{entry.name} {entry.version}</Text>
        <Text style={{ color: theme.muted, fontSize: 14 }}>{entry.license}</Text>
      </Pressable>
      {open && <Text selectable style={{ color: theme.text, fontSize: 12, fontFamily: 'Menlo' }}>{entry.text}</Text>}
    </View>
  );
}

/**
 * What the app is, where its source is, and the notices for the packages built into it, which their licences
 * ask to go with the app. Also the server's own source offer, from discovery, because the server is AGPL.
 * See docs/operations/licensing.md.
 */
export function AboutScreen() {
  const { api, connection } = useWorkspace();
  const discovery = useQuery({ queryKey: ['discovery'], queryFn: () => api.getDiscovery(), staleTime: Infinity });
  const software = discovery.data?.software;
  const name = Constants.expoConfig?.name ?? 'This app';
  const version = Constants.expoConfig?.version;
  return (
    <Screen>
      <Title>{name}</Title>
      <Body muted>{version ? `Version ${version}. ` : ''}Free software under the Apache License 2.0, built from OpenChat.</Body>
      <Button title="App source code" kind="plain" onPress={() => void Linking.openURL(PROJECT)} />
      <Body>{connection.installationName}</Body>
      <Body muted>
        {software ? `Runs OpenChat${software.version ? ` ${software.version}` : ''}, under the GNU AGPL.` : 'Runs OpenChat, under the GNU AGPL.'}
      </Body>
      <Button title="Server source code" kind="plain" onPress={() => void Linking.openURL(software?.source ?? PROJECT)} />
      <Body>Open-source licences</Body>
      <Body muted>{`This app includes ${(licenses as License[]).length} open-source packages. Tap one to read its licence.`}</Body>
      {(licenses as License[]).map((entry) => (
        <Package key={`${entry.name}@${entry.version}`} entry={entry} />
      ))}
    </Screen>
  );
}
