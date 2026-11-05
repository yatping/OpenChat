import type { DiscoveryResponse } from '@openchat/api-client';
import { useState } from 'react';
import { checkCompatibility, normalizeInstallationUrl } from '../connections/discovery';
import { connections } from '../connections/native';
import { Body, Button, Field, Problem, Screen, Title } from '../ui/kit';
import { UpgradeMessage } from './upgrade';

export type Found = { baseUrl: string; discovery: DiscoveryResponse };

const MESSAGES = {
  invalid: 'That does not look like a web address. Try something like chat.example.com.',
  insecure: 'This app only connects over HTTPS.',
  unreachable: 'That address could not be reached. Check it and your connection, then try again.',
  not_openchat: 'That address did not answer as an OpenChat installation.',
};

export function ConnectScreen({ onFound }: { onFound: (found: Found) => void }) {
  const [address, setAddress] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<keyof typeof MESSAGES | null>(null);
  const [outOfRange, setOutOfRange] = useState<{ name: string; compatibility: 'update_app' | 'update_installation' } | null>(null);

  const submit = async () => {
    setProblem(null);
    setOutOfRange(null);
    const url = normalizeInstallationUrl(address, { allowLocalHttp: __DEV__ });
    if (!url.ok) return setProblem(url.reason);
    setBusy(true);
    const result = await connections.discover(url.baseUrl);
    setBusy(false);
    if (!result.ok) return setProblem(result.reason);
    const compatibility = checkCompatibility(result.discovery);
    if (compatibility !== 'compatible') return setOutOfRange({ name: result.discovery.name, compatibility });
    onFound({ baseUrl: url.baseUrl, discovery: result.discovery });
  };

  return (
    <Screen>
      <Title>Connect to your team</Title>
      <Body muted>Enter the address of your OpenChat installation. Your administrator can give it to you.</Body>
      <Field label="Address" value={address} onChangeText={setAddress} placeholder="chat.example.com" keyboardType="url" textContentType="URL" returnKeyType="go" onSubmitEditing={() => void submit()} />
      {problem && <Problem>{MESSAGES[problem]}</Problem>}
      {outOfRange && <UpgradeMessage name={outOfRange.name} compatibility={outOfRange.compatibility} />}
      <Button title="Continue" busy={busy} onPress={() => void submit()} />
    </Screen>
  );
}
