import type { Conversation } from '@openchat/api-client';
import { useRoute, type RouteProp } from '@react-navigation/native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Body, Button, Field, Problem, Screen, useTheme } from '../ui/kit';
import { detailKey, listKey } from './cache';
import { useWorkspace, type Routes } from './connected-app';

function Tags({ conversation }: { conversation: Conversation }) {
  const theme = useTheme();
  const client = useQueryClient();
  const { api, workspaceId, cache } = useWorkspace();
  const available = useQuery({ queryKey: ['tags', workspaceId], queryFn: () => api.listTags(workspaceId) });
  const [name, setName] = useState('');
  const set = useMutation({
    mutationFn: async (next: Conversation['tags']) => {
      await api.setConversationTags(workspaceId, conversation.id, next.map((tag) => tag.id));
      return next;
    },
    onSuccess: (tags) => cache.applyPatch({ id: conversation.id, version: conversation.version, tags }),
  });
  const add = useMutation({
    mutationFn: () => api.createTag(workspaceId, name.trim()),
    onSuccess: (tag) => {
      setName('');
      void client.invalidateQueries({ queryKey: ['tags', workspaceId] });
      if (!conversation.tags.some((known) => known.id === tag.id)) set.mutate([...conversation.tags, tag]);
    },
  });
  const unused = (available.data?.data ?? []).filter((tag) => !conversation.tags.some((known) => known.id === tag.id));
  return (
    <>
      <Text accessibilityRole="header" style={[styles.heading, { color: theme.text }]}>Tags</Text>
      {conversation.tags.length === 0 && <Body muted>No tags yet.</Body>}
      <View style={styles.tags}>
        {conversation.tags.map((tag) => (
          <Pressable key={tag.id} accessibilityRole="button" accessibilityLabel={`Remove tag ${tag.name}`} disabled={set.isPending} onPress={() => set.mutate(conversation.tags.filter((other) => other.id !== tag.id))} style={[styles.tag, { backgroundColor: theme.primary }]}>
            <Text style={{ color: theme.onPrimary }}>{tag.name} ×</Text>
          </Pressable>
        ))}
        {unused.map((tag) => (
          <Pressable key={tag.id} accessibilityRole="button" accessibilityLabel={`Add tag ${tag.name}`} disabled={set.isPending} onPress={() => set.mutate([...conversation.tags, tag])} style={[styles.tag, { backgroundColor: theme.surface }]}>
            <Text style={{ color: theme.text }}>+ {tag.name}</Text>
          </Pressable>
        ))}
      </View>
      <Field label="New tag" value={name} maxLength={50} autoCapitalize="sentences" onChangeText={setName} />
      <Button title="Add tag" kind="plain" busy={add.isPending} disabled={!name.trim() || set.isPending} onPress={() => add.mutate()} />
      {(add.error ?? set.error) && <Problem>That tag did not save. Please try again.</Problem>}
    </>
  );
}

function ContactForm({ contactId, conversationId }: { contactId: string; conversationId: string }) {
  const theme = useTheme();
  const client = useQueryClient();
  const { api, workspaceId } = useWorkspace();
  const key = ['contact', workspaceId, contactId];
  const contact = useQuery({ queryKey: key, queryFn: () => api.getContact(workspaceId, contactId) });
  const [edits, setEdits] = useState<{ name?: string; email?: string; phone?: string }>({});
  const save = useMutation({
    // An emptied field clears it. Only what was touched is sent.
    mutationFn: () => api.updateContact(workspaceId, contactId, Object.fromEntries(Object.entries(edits).map(([field, value]) => [field, value.trim() || null]))),
    onSuccess: (saved) => {
      client.setQueryData(key, saved);
      setEdits({});
      void client.invalidateQueries({ queryKey: listKey(workspaceId) });
      void client.invalidateQueries({ queryKey: detailKey(workspaceId, conversationId) });
    },
  });
  const data = contact.data;
  return (
    <>
      <Text accessibilityRole="header" style={[styles.heading, { color: theme.text }]}>Contact</Text>
      {contact.error && <Problem>Could not load this contact. Check your connection.</Problem>}
      <Field label="Name" value={edits.name ?? data?.name ?? ''} maxLength={100} autoCapitalize="words" onChangeText={(name) => setEdits({ ...edits, name })} />
      <Field label="Email" value={edits.email ?? data?.email ?? ''} maxLength={254} keyboardType="email-address" onChangeText={(email) => setEdits({ ...edits, email })} />
      {data?.email && <Body muted>Not verified. Anyone can type any address.</Body>}
      <Field label="Phone" value={edits.phone ?? data?.phone ?? ''} maxLength={40} keyboardType="phone-pad" onChangeText={(phone) => setEdits({ ...edits, phone })} />
      {save.error && <Problem>That did not save. Check the details and try again.</Problem>}
      {Object.keys(edits).length > 0 && <Button title="Save contact" busy={save.isPending} onPress={() => save.mutate()} />}
      {data && <Body muted>First seen {new Date(data.firstSeenAt).toLocaleDateString()}</Body>}
    </>
  );
}

export function DetailsScreen() {
  const { conversationId } = useRoute<RouteProp<Routes, 'Details'>>().params;
  const { api, workspaceId } = useWorkspace();
  const conversation = useQuery({ queryKey: detailKey(workspaceId, conversationId), queryFn: () => api.getConversation(workspaceId, conversationId) });
  const data = conversation.data;
  return (
    <Screen>
      {conversation.error && <Problem>Could not load this conversation. Check your connection.</Problem>}
      {data && <ContactForm contactId={data.contactId} conversationId={conversationId} />}
      {data && <Tags conversation={data} />}
    </Screen>
  );
}

const styles = StyleSheet.create({
  heading: { fontSize: 20, fontWeight: '700', marginTop: 8 },
  tags: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  tag: { minHeight: 36, borderRadius: 18, paddingHorizontal: 14, justifyContent: 'center' },
});
