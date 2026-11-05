import type { Conversation } from '@openchat/api-client';
import { unreadCount, type InboxFilter } from '@openchat/api-client/inbox-state';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useLayoutEffect, useState } from 'react';
import { FlatList, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Body, Problem, useTheme } from '../ui/kit';
import { listKey } from './cache';
import { useWorkspace, type Routes } from './connected-app';
import { conversationLabel, shortTime } from './format';

const STATUSES: { value: Conversation['status']; label: string }[] = [
  { value: 'open', label: 'Open' },
  { value: 'pending', label: 'Pending' },
  { value: 'resolved', label: 'Resolved' },
];
const ASSIGNEES = [
  { value: 'all', label: 'Everyone' },
  { value: 'me', label: 'Me' },
  { value: 'none', label: 'Unassigned' },
] as const;

function Pill({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  const theme = useTheme();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ selected }} onPress={onPress} style={[styles.pill, { backgroundColor: selected ? theme.primary : theme.surface }]}>
      <Text style={{ color: selected ? theme.onPrimary : theme.text, fontWeight: '600' }}>{label}</Text>
    </Pressable>
  );
}

export function ConnectionNotice() {
  const { live } = useWorkspace();
  if (live.status === 'connected' || live.status === 'connecting') return null;
  return (
    <View style={{ paddingHorizontal: 16, paddingBottom: 6 }} accessibilityLiveRegion="polite">
      <Body muted>{live.status === 'polling' ? 'Live updates are unavailable. Checking every few seconds.' : 'Reconnecting…'}</Body>
    </View>
  );
}

export function InboxScreen() {
  const theme = useTheme();
  const navigation = useNavigation<NativeStackNavigationProp<Routes, 'Inbox'>>();
  const { api, workspaceId, memberId, live } = useWorkspace();
  const [status, setStatus] = useState<Conversation['status']>('open');
  const [assignee, setAssignee] = useState<'all' | 'me' | 'none'>('all');
  const filter: InboxFilter = { status, assignee: assignee === 'all' ? undefined : assignee === 'me' ? memberId : 'none' };

  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <Pressable accessibilityRole="button" accessibilityLabel="Settings" onPress={() => navigation.navigate('Settings')} hitSlop={8} style={{ paddingHorizontal: 8 }}>
          <Text style={{ color: theme.primary, fontSize: 16 }}>Settings</Text>
        </Pressable>
      ),
    });
  }, [navigation, theme.primary]);

  const list = useInfiniteQuery({
    queryKey: [...listKey(workspaceId), filter],
    queryFn: ({ pageParam }) => api.listConversations(workspaceId, { status: filter.status, assignee: filter.assignee, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = list.data?.pages.flatMap((page) => page.data) ?? [];

  return (
    <View style={{ flex: 1, backgroundColor: theme.background }}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.filters} contentContainerStyle={styles.filterRow}>
        {STATUSES.map((option) => <Pill key={option.value} label={option.label} selected={status === option.value} onPress={() => setStatus(option.value)} />)}
        <View style={{ width: 8 }} />
        {ASSIGNEES.map((option) => <Pill key={option.value} label={option.label} selected={assignee === option.value} onPress={() => setAssignee(option.value)} />)}
      </ScrollView>
      <ConnectionNotice />
      {list.error && <View style={{ paddingHorizontal: 16 }}><Problem>Could not load conversations. Pull down to try again.</Problem></View>}
      <FlatList
        data={rows}
        keyExtractor={(row) => row.id}
        refreshControl={<RefreshControl refreshing={list.isRefetching && !list.isFetchingNextPage} onRefresh={() => void list.refetch()} />}
        onEndReached={() => {
          if (list.hasNextPage && !list.isFetchingNextPage) void list.fetchNextPage();
        }}
        ListEmptyComponent={list.data ? <View style={{ padding: 16 }}><Body muted>No conversations here.</Body></View> : list.isPending ? <View style={{ padding: 16 }}><Body muted>Loading…</Body></View> : undefined}
        renderItem={({ item }) => {
          const unread = unreadCount(item);
          const online = live.visitorsOnline.has(item.id);
          const name = conversationLabel(item);
          return (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${name}${unread > 0 ? `, ${unread} unread` : ''}${online ? ', online now' : ''}`}
              onPress={() => navigation.navigate('Conversation', { conversationId: item.id })}
              style={({ pressed }) => [styles.row, { borderBottomColor: theme.border, backgroundColor: pressed ? theme.surface : theme.background }]}
            >
              <View style={[styles.dot, { backgroundColor: online ? '#16a34a' : 'transparent' }]} />
              <Text numberOfLines={1} style={{ flex: 1, fontSize: 16, color: theme.text, fontWeight: unread > 0 ? '700' : '400' }}>{name}</Text>
              {item.lastMessageAt && <Text style={{ color: theme.muted, fontSize: 13 }}>{shortTime(item.lastMessageAt)}</Text>}
              {unread > 0 && <View style={[styles.badge, { backgroundColor: theme.primary }]}><Text style={{ color: theme.onPrimary, fontSize: 12, fontWeight: '700' }}>{unread}</Text></View>}
            </Pressable>
          );
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  filters: { flexGrow: 0 },
  filterRow: { paddingHorizontal: 12, paddingVertical: 10, gap: 8 },
  pill: { paddingHorizontal: 14, minHeight: 36, borderRadius: 18, justifyContent: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, minHeight: 60, borderBottomWidth: StyleSheet.hairlineWidth },
  dot: { width: 8, height: 8, borderRadius: 4 },
  badge: { minWidth: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6 },
});
