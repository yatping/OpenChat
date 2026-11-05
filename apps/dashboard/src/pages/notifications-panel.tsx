import type { NotificationPreferences } from '@openchat/api-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errorMessage } from '../app-context';

const CHOICES = [
  { eventType: 'new_conversation', label: 'New conversations' },
  { eventType: 'conversation_unanswered', label: 'A visitor has been waiting about 15 minutes for a reply' },
] as const;

export function NotificationsPanel({ workspaceId }: { workspaceId: string }) {
  const client = useQueryClient();
  const key = ['notification-preferences', workspaceId];
  const preferences = useQuery({ queryKey: key, queryFn: () => api.getNotificationPreferences(workspaceId) });
  const save = useMutation({
    mutationFn: (next: NotificationPreferences) => api.setNotificationPreferences(workspaceId, next),
    onMutate: (next) => client.setQueryData(key, next),
    onError: () => client.invalidateQueries({ queryKey: key }),
  });
  const toggle = (eventType: (typeof CHOICES)[number]['eventType'], enabled: boolean) => {
    const others = (preferences.data?.preferences ?? []).filter((p) => !(p.channel === 'email' && p.eventType === eventType));
    save.mutate({ preferences: [...others, { eventType, channel: 'email', enabled }] });
  };
  return (
    <section className="card space-y-3" aria-label="Notifications">
      <h2 className="font-medium">Email me about</h2>
      {preferences.error ? <p className="error" role="alert">{errorMessage(preferences.error)}</p> : null}
      {save.error ? <p className="error" role="alert">{errorMessage(save.error)}</p> : null}
      {CHOICES.map(({ eventType, label }) => (
        <label key={eventType} className="flex items-center gap-3 text-sm">
          <input
            type="checkbox"
            disabled={!preferences.data}
            checked={preferences.data?.preferences.find((p) => p.channel === 'email' && p.eventType === eventType)?.enabled ?? false}
            onChange={(event) => toggle(eventType, event.target.checked)}
          />
          {label}
        </label>
      ))}
      <p className="text-xs text-slate-600 dark:text-slate-400">These emails say only that something happened, and never include what anyone wrote. Each workspace has its own settings.</p>
    </section>
  );
}
