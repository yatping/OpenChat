import type { FailedJob } from '@openchat/api-client';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, errorMessage } from '../app-context';

const KEY = ['failed-jobs'];

/** What each job did, in words. Anything else shows its type. */
const JOB_NAMES: Record<string, string> = {
  'notification.fanout': 'Work out who to notify',
  'notification.dispatch': 'Send push notifications',
  'notification.unregister': 'Remove a phone from push',
  'email.follow_up': 'Follow-up email',
  'automation.evaluate': 'Check follow-up rules',
  'auth.password_reset_email': 'Password reset email',
  'auth.new_account_email': 'New account email',
};

function Failure({ error }: { error: unknown }) {
  return error ? <p className="error" role="alert">{errorMessage(error)}</p> : null;
}

const when = (iso: string) => <time dateTime={iso}>{new Date(iso).toLocaleString()}</time>;

/**
 * Background jobs that failed for good. Replaying queues the job again with its idempotency key, so work it already
 * did is not repeated. The API answers 404 to anyone but an installation admin. See docs/architecture/background-jobs.md.
 */
export function FailedJobsPage() {
  const jobs = useInfiniteQuery({
    queryKey: KEY,
    queryFn: ({ pageParam }) => api.listFailedJobs({ cursor: pageParam, limit: 50 }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const list = jobs.data?.pages.flatMap((page) => page.data) ?? [];
  return (
    <section className="space-y-4" aria-label="Failed jobs">
      <p className="text-sm text-slate-600 dark:text-slate-400">
        Background work that failed after every retry, such as an email or a push notification. Fix the cause first, then replay. Work a job already finished is not repeated. Job contents are not shown.
      </p>
      <Failure error={jobs.error} />
      {jobs.data && list.length === 0 && <p className="card text-sm">No failed jobs.</p>}
      <ul className="space-y-3">
        {list.map((job) => <FailedJobCard key={job.id} job={job} />)}
      </ul>
      {jobs.hasNextPage && (
        <button className="button-quiet" disabled={jobs.isFetchingNextPage} onClick={() => void jobs.fetchNextPage()}>
          Show older
        </button>
      )}
    </section>
  );
}

function FailedJobCard({ job }: { job: FailedJob }) {
  const client = useQueryClient();
  const refresh = { onSettled: () => client.invalidateQueries({ queryKey: KEY }) };
  const replay = useMutation({ mutationFn: () => api.replayFailedJob(job.id), ...refresh });
  const dismiss = useMutation({ mutationFn: () => api.dismissFailedJob(job.id), ...refresh });
  const name = JOB_NAMES[job.jobType] ?? job.jobType;
  return (
    <li className="card space-y-2" aria-label={name}>
      <div className="flex flex-wrap items-baseline gap-2">
        <h2 className="flex-1 font-medium">{name}</h2>
        <span className="text-xs text-slate-600 dark:text-slate-400">Failed {when(job.failedAt)}</span>
      </div>
      <p className="text-sm">
        {job.workspace ? <>Workspace {job.workspace.name}</> : 'No workspace'} · {job.attempts} {job.attempts === 1 ? 'attempt' : 'attempts'} · <code className="text-xs">{job.jobType}</code>
      </p>
      {job.replayedAt && <p className="text-sm">Replayed {when(job.replayedAt)}. If it failed again, it is listed again.</p>}
      {!job.replayedAt && !job.replayable && <p className="text-sm">This job cannot be replayed: it is past the time it had to run by, or it could not be read.</p>}
      <div className="flex flex-wrap gap-2">
        {job.replayable && (
          <button className="button" disabled={replay.isPending} onClick={() => replay.mutate()}>
            Replay
          </button>
        )}
        <button className="button-quiet" disabled={dismiss.isPending} onClick={() => dismiss.mutate()}>
          Dismiss
        </button>
      </div>
      <Failure error={replay.error ?? dismiss.error} />
    </li>
  );
}
