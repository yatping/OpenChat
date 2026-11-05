import { ApiError, type Attachment, type Conversation, type Message } from '@openchat/api-client';
import { highestSeq, mergeMessages, shouldSendTyping } from '@openchat/api-client/inbox-state';
import { useIsFocused, useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { randomUUID } from 'expo-crypto';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ActionSheetIOS, ActivityIndicator, AppState, FlatList, Image, KeyboardAvoidingView, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useHeaderHeight } from '@react-navigation/elements';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Body, Button, Problem, useTheme } from '../ui/kit';
import { localCopy, openFile, pickDocument, pickPhoto, TooLarge, uploadPicked, type Picked } from './attachment-files';
import { canPreview, formatSize, uploadProblem } from './attachment-rules';
import { detailKey, threadKey } from './cache';
import { useWorkspace, type Routes } from './connected-app';
import { conversationLabel, shortTime } from './format';
import { ConnectionNotice } from './inbox-screen';

const STATUSES: Conversation['status'][] = ['open', 'pending', 'resolved', 'archived'];
const PRIORITIES: Conversation['priority'][] = ['low', 'normal', 'high', 'urgent'];
const MAX_MESSAGE_CHARS = 16000;
/** The installation's limit for one message. */
const MAX_FILES = 10;

function choose(title: string, options: string[], onPick: (index: number) => void) {
  ActionSheetIOS.showActionSheetWithOptions({ title, options: [...options, 'Cancel'], cancelButtonIndex: options.length }, (index) => {
    if (index < options.length) onPick(index);
  });
}

function AttachmentView({ file, color }: { file: Attachment; color: string }) {
  const { api, connection } = useWorkspace();
  const previewable = canPreview(file);
  const preview = useQuery({ queryKey: ['attachment-file', file.id], queryFn: () => localCopy(api, connection.id, file), enabled: previewable, staleTime: Infinity });
  const open = useMutation({ mutationFn: async () => openFile(await localCopy(api, connection.id, file), file.contentType, file.filename) });
  if (file.status !== 'ready') return <Text style={{ fontSize: 14, color }}>{file.filename} (not available)</Text>;
  return (
    <View style={{ gap: 4 }}>
      <Pressable accessibilityRole="button" accessibilityLabel={`Open ${file.filename}, ${formatSize(file.size)}`} disabled={open.isPending} onPress={() => open.mutate()}>
        {preview.data && <Image accessibilityIgnoresInvertColors source={{ uri: preview.data }} resizeMode="cover" style={styles.preview} />}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 28 }}>
          <Text style={{ fontSize: 14, color, textDecorationLine: 'underline', flexShrink: 1 }}>{file.filename} ({formatSize(file.size)})</Text>
          {open.isPending && <ActivityIndicator size="small" />}
        </View>
      </Pressable>
      {open.error && <Text style={{ fontSize: 13, color }}>That did not open. Try again.</Text>}
    </View>
  );
}

function Bubble({ message, memberId }: { message: Message; memberId: string }) {
  const theme = useTheme();
  if (message.type === 'system') return <Text style={[styles.system, { color: theme.muted }]}>{message.content}</Text>;
  const note = message.visibility === 'internal';
  const mine = message.sender.type === 'member' && message.sender.id === memberId;
  const member = message.sender.type === 'member';
  const sender = message.sender.displayName || (member ? 'A teammate' : 'Visitor');
  return (
    <View style={[styles.bubble, { alignSelf: member ? 'flex-end' : 'flex-start', backgroundColor: note ? '#fef3c7' : mine ? theme.primary : theme.surface }]}>
      <Text style={{ fontSize: 13, fontWeight: '600', color: note ? '#78350f' : mine ? theme.onPrimary : theme.muted }}>
        {note ? `Note, ${sender}` : sender} · {shortTime(message.createdAt)}
      </Text>
      {message.content.length > 0 && <Text selectable style={{ fontSize: 16, lineHeight: 22, color: note ? '#451a03' : mine ? theme.onPrimary : theme.text }}>{message.content}</Text>}
      {message.attachments.map((file) => <AttachmentView key={file.id} file={file} color={note ? '#78350f' : mine ? theme.onPrimary : theme.text} />)}
    </View>
  );
}

function Composer({ conversationId }: { conversationId: string }) {
  const theme = useTheme();
  const { api, workspaceId, cache, live } = useWorkspace();
  const [draft, setDraft] = useState('');
  const [mode, setMode] = useState<'text' | 'internal_note'>('text');
  // The same attempt keeps its ID, so that retrying after a lost response cannot send it twice.
  const attempt = useRef<{ id: string; content: string; type: string; files: string } | null>(null);
  const [files, setFiles] = useState<{ id: string; filename: string }[]>([]);
  const [uploading, setUploading] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const lastTyping = useRef(0);
  const note = mode === 'internal_note';

  const send = useMutation({
    mutationFn: (input: { id: string; content: string; type: 'text' | 'internal_note'; attachmentIds: string[] }) => api.sendMessage(workspaceId, conversationId, { clientMessageId: input.id, type: input.type, content: input.content, ...(input.attachmentIds.length > 0 ? { attachmentIds: input.attachmentIds } : {}) }),
    onSuccess: (message) => {
      attempt.current = null;
      cache.messageSent(conversationId, message);
      setDraft('');
      setFiles([]);
    },
  });
  const submit = () => {
    const content = draft.trim();
    if ((!content && files.length === 0) || send.isPending || uploading > 0) return;
    const attachmentIds = files.map((file) => file.id);
    const fileKey = attachmentIds.join();
    if (attempt.current?.content !== content || attempt.current.type !== mode || attempt.current.files !== fileKey) attempt.current = { id: randomUUID(), content, type: mode, files: fileKey };
    send.mutate({ id: attempt.current.id, content, type: mode, attachmentIds });
  };
  const upload = async (pick: () => Promise<Picked | null>) => {
    setUploadError(null);
    try {
      const picked = await pick();
      if (!picked) return;
      setUploading((count) => count + 1);
      try {
        const stored = await uploadPicked(api, workspaceId, conversationId, picked);
        setFiles((known) => [...known, { id: stored.id, filename: stored.filename }]);
      } finally {
        setUploading((count) => count - 1);
      }
    } catch (error) {
      setUploadError(error instanceof TooLarge ? uploadProblem(413) : uploadProblem(error instanceof ApiError ? error.status : undefined));
    }
  };
  const attach = () => choose('Add a file', ['Photo', 'Document'], (index) => void upload(index === 0 ? pickPhoto : pickDocument));

  return (
    <View style={[styles.composer, { borderTopColor: theme.border, backgroundColor: note ? '#fffbeb' : theme.background }]}>
      {send.error && <Problem>{send.error instanceof ApiError && send.error.status === 403 ? 'You cannot reply to this conversation.' : 'That did not send. Your message is still here, so try again.'}</Problem>}
      {uploadError && <Problem>{uploadError}</Problem>}
      <View style={styles.modes}>
        <Button title={note ? 'Write a reply instead' : 'Write a note instead'} kind="plain" onPress={() => setMode(note ? 'text' : 'internal_note')} />
        <Button title="Add a file" kind="plain" busy={uploading > 0} disabled={files.length >= MAX_FILES} onPress={attach} />
      </View>
      {files.map((file) => (
        <View key={file.id} style={styles.picked}>
          <Text numberOfLines={1} style={{ flex: 1, color: note ? '#451a03' : theme.text }}>{file.filename}</Text>
          <Pressable accessibilityRole="button" accessibilityLabel={`Remove ${file.filename}`} hitSlop={8} onPress={() => setFiles((known) => known.filter((other) => other.id !== file.id))}>
            <Text style={{ color: theme.danger }}>Remove</Text>
          </Pressable>
        </View>
      ))}
      <TextInput
        accessibilityLabel={note ? 'Internal note' : 'Reply'}
        placeholder={note ? 'Only your team can see this' : 'Reply to the visitor'}
        placeholderTextColor={note ? '#78350f' : theme.muted}
        multiline
        maxLength={MAX_MESSAGE_CHARS}
        value={draft}
        onChangeText={(value) => {
          setDraft(value);
          const now = Date.now();
          if (value && shouldSendTyping(lastTyping.current, now)) {
            lastTyping.current = now;
            live.realtime.current?.send('typing.set', { conversationId, isTyping: true, internal: note });
          }
        }}
        style={[styles.input, { color: note ? '#451a03' : theme.text, borderColor: theme.border }]}
      />
      <Button title={note ? 'Save note' : 'Send reply'} busy={send.isPending} disabled={(!draft.trim() && files.length === 0) || uploading > 0} onPress={submit} />
    </View>
  );
}

export function ConversationScreen() {
  const theme = useTheme();
  const client = useQueryClient();
  const navigation = useNavigation<NativeStackNavigationProp<Routes>>();
  const headerHeight = useHeaderHeight();
  const insets = useSafeAreaInsets();
  const { conversationId } = useRoute<RouteProp<Routes, 'Conversation'>>().params;
  const { api, workspaceId, memberId, cache, live, openConversation } = useWorkspace();
  const focused = useIsFocused();

  useEffect(() => {
    openConversation.current = conversationId;
    return () => {
      openConversation.current = null;
    };
  }, [conversationId, openConversation]);

  const conversation = useQuery({ queryKey: detailKey(workspaceId, conversationId), queryFn: () => api.getConversation(workspaceId, conversationId) });
  const key = threadKey(workspaceId, conversationId);
  const messages = useQuery({ queryKey: key, queryFn: async () => (await api.listMessages(workspaceId, conversationId)).data, staleTime: Infinity });
  const members = useQuery({ queryKey: ['members', workspaceId], queryFn: () => api.listMembers(workspaceId), staleTime: 60_000 });
  const rows = useMemo(() => messages.data ?? [], [messages.data]);
  const newestFirst = useMemo(() => [...rows].reverse(), [rows]);
  const data = conversation.data;
  const name = data ? conversationLabel(data) : '';

  useLayoutEffect(() => {
    navigation.setOptions({
      title: name,
      headerRight: () => (
        <Pressable accessibilityRole="button" accessibilityLabel="Contact and tags" onPress={() => navigation.navigate('Details', { conversationId })} hitSlop={8} style={{ paddingHorizontal: 8 }}>
          <Text style={{ color: theme.primary, fontSize: 16 }}>Details</Text>
        </Pressable>
      ),
    });
  }, [conversationId, name, navigation, theme.primary]);

  const [noMoreHistory, setNoMoreHistory] = useState(false);
  const older = useMutation({
    mutationFn: () => api.listMessages(workspaceId, conversationId, { beforeSeq: rows[0]!.seq }),
    onSuccess: ({ data: page }) => {
      if (page.length === 0) setNoMoreHistory(true);
      client.setQueryData<Message[]>(key, (known) => mergeMessages(known ?? [], page));
    },
  });

  const update = useMutation({
    mutationFn: (change: { status?: Conversation['status']; priority?: Conversation['priority']; assignedMemberId?: string | null }) => api.updateConversation(workspaceId, conversationId, { ...change, expectedVersion: data!.version }),
    onSuccess: (updated) => cache.applyPatch(updated),
    onError: () => void client.invalidateQueries({ queryKey: detailKey(workspaceId, conversationId) }),
  });

  const newest = highestSeq(rows);
  const reported = useRef(0);
  useEffect(() => {
    const mark = () => {
      if (!focused || AppState.currentState !== 'active' || newest === 0 || newest <= reported.current || (data?.lastReadSeq ?? 0) >= newest) return;
      reported.current = newest;
      api
        .markConversationRead(workspaceId, conversationId, newest)
        .then(() => cache.markedRead(conversationId, newest))
        .catch(() => {
          // It stays unread, and the next look tries again.
          reported.current = 0;
        });
    };
    mark();
    const subscription = AppState.addEventListener('change', mark);
    return () => subscription.remove();
  }, [api, cache, conversationId, data?.lastReadSeq, focused, newest, workspaceId]);

  const memberList = members.data?.data ?? [];
  const memberName = (id: string) => memberList.find((member) => member.id === id)?.name ?? 'A teammate';
  const typists = live.typing.filter((entry) => entry.conversationId === conversationId).map((entry) => (entry.actorType === 'visitor' ? 'The visitor' : memberName(entry.actorId)));
  const assignable = memberList.filter((member) => member.status === 'active');
  const conflict = update.error instanceof ApiError && update.error.status === 409;
  // A 404 means access has gone, or the conversation has. Say so, and show nothing else.
  const gone = conversation.error instanceof ApiError && conversation.error.status === 404;

  if (gone) {
    return (
      <View style={{ flex: 1, padding: 20, gap: 14, backgroundColor: theme.background }}>
        <Body>This conversation is not available. It may have been removed, or you may no longer have access.</Body>
        <Button title="Back to the inbox" onPress={() => navigation.goBack()} />
      </View>
    );
  }

  return (
    <KeyboardAvoidingView behavior="padding" keyboardVerticalOffset={headerHeight} style={{ flex: 1, backgroundColor: theme.background }}>
      <ConnectionNotice />
      {data && (
        <View style={[styles.actions, { borderBottomColor: theme.border }]}>
          <Pressable accessibilityRole="button" accessibilityLabel={`Status: ${data.status}`} disabled={update.isPending} onPress={() => choose('Status', STATUSES, (index) => update.mutate({ status: STATUSES[index]! }))} style={[styles.action, { backgroundColor: theme.surface }]}>
            <Text numberOfLines={1} style={{ color: theme.text }}>{data.status}</Text>
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel={`Priority: ${data.priority}`} disabled={update.isPending} onPress={() => choose('Priority', PRIORITIES, (index) => update.mutate({ priority: PRIORITIES[index]! }))} style={[styles.action, { backgroundColor: theme.surface }]}>
            <Text numberOfLines={1} style={{ color: theme.text }}>{data.priority}</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Assigned to: ${data.assignedMemberId ? memberName(data.assignedMemberId) : 'nobody'}`}
            disabled={update.isPending}
            onPress={() => choose('Assign to', ['Unassigned', ...assignable.map((member) => (member.id === memberId ? `${member.name} (you)` : member.name))], (index) => update.mutate({ assignedMemberId: index === 0 ? null : assignable[index - 1]!.id }))}
            style={[styles.action, { flex: 1, backgroundColor: theme.surface }]}
          >
            <Text numberOfLines={1} style={{ color: theme.text }}>{data.assignedMemberId ? memberName(data.assignedMemberId) : 'Unassigned'}</Text>
          </Pressable>
        </View>
      )}
      {update.error && <View style={{ paddingHorizontal: 16 }}><Problem>{conflict ? 'This conversation just changed. Check it and try again.' : 'That change did not save. Please try again.'}</Problem></View>}
      {(messages.error ?? conversation.error) && <View style={{ paddingHorizontal: 16 }}><Problem>Could not load this conversation. Check your connection.</Problem></View>}
      <FlatList
        inverted
        style={{ flex: 1 }}
        data={newestFirst}
        keyExtractor={(message) => message.id}
        contentContainerStyle={{ padding: 12, gap: 8 }}
        keyboardShouldPersistTaps="handled"
        renderItem={({ item }) => <Bubble message={item} memberId={memberId} />}
        onEndReached={() => {
          if (rows.length > 0 && (rows[0]?.seq ?? 1) > 1 && !noMoreHistory && !older.isPending) older.mutate();
        }}
      />
      <View accessibilityLiveRegion="polite" style={{ minHeight: 20, paddingHorizontal: 16 }}>
        {typists.length > 0 && <Text style={{ color: theme.muted, fontSize: 13 }}>{typists.join(', ')} {typists.length > 1 ? 'are' : 'is'} typing…</Text>}
      </View>
      <View style={{ paddingBottom: insets.bottom }}>
        <Composer conversationId={conversationId} />
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  system: { textAlign: 'center', fontSize: 13 },
  bubble: { maxWidth: '85%', borderRadius: 14, paddingHorizontal: 12, paddingVertical: 8, gap: 2 },
  composer: { padding: 10, gap: 8, borderTopWidth: StyleSheet.hairlineWidth },
  modes: { flexDirection: 'row', gap: 8 },
  picked: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 32 },
  preview: { width: 220, height: 160, borderRadius: 8 },
  input: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingTop: 10, paddingBottom: 10, minHeight: 44, maxHeight: 140, fontSize: 16 },
  actions: { flexDirection: 'row', gap: 8, paddingHorizontal: 12, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth },
  action: { minHeight: 36, borderRadius: 18, paddingHorizontal: 14, justifyContent: 'center' },
});
