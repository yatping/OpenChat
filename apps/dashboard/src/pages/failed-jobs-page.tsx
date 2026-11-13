import type { FailedJob } from '@openchat/api-client';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, errorMessage } from '../app-context';
import { intlLocale, t, tn, tNode, type MessageKey } from '../i18n';

const KEY = ['failed-jobs'];

/** What each job did, in words. Anything else shows its type. */
const JOB_NAMES: Record<string, MessageKey> = {
  'notification.fanout': 'jobFanout',
  'notification.dispatch': 'jobDispatch',
  'notification.unregister': 'jobUnregister',
  'email.follow_up': 'jobFollowUp',
  'automation.evaluate': 'jobAutomation',
  'auth.password_reset_email': 'jobPasswordReset',
  'auth.new_account_email': 'jobNewAccount',
};

function Failure({ error }: { error: unknown }) {
  return error ? <p className="error" role="alert">{errorMessage(error)}</p> : null;
}

const when = (iso: string) => <time dateTime={iso}>{new Date(iso).toLocaleString(intlLocale())}</time>;

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
    <section className="space-y-4" aria-label={t('adminJobs')}>
      <p className="text-sm text-slate-600 dark:text-slate-400">
        {t('failedJobsHelp')}
      </p>
      <Failure error={jobs.error} />
      {jobs.data && list.length === 0 && <p className="card text-sm">{t('noFailedJobs')}</p>}
      <ul className="space-y-3">
        {list.map((job) => <FailedJobCard key={job.id} job={job} />)}
      </ul>
      {jobs.hasNextPage && (
        <button className="button-quiet" disabled={jobs.isFetchingNextPage} onClick={() => void jobs.fetchNextPage()}>
          {t('showOlder')}
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
  const known = JOB_NAMES[job.jobType];
  const name = known ? t(known) : job.jobType;
  return (
    <li className="card space-y-2" aria-label={name}>
      <div className="flex flex-wrap items-baseline gap-2">
        <h2 className="flex-1 font-medium">{name}</h2>
        <span className="text-xs text-slate-600 dark:text-slate-400">{tNode('failedAt', { when: when(job.failedAt) })}</span>
      </div>
      <p className="text-sm">
        {job.workspace ? t('workspaceNamed', { name: job.workspace.name }) : t('noWorkspace')} · {tn('attempts', job.attempts)} · <code className="text-xs">{job.jobType}</code>
      </p>
      {job.replayedAt && <p className="text-sm">{tNode('replayedAt', { when: when(job.replayedAt) })}</p>}
      {!job.replayedAt && !job.replayable && <p className="text-sm">{t('cannotReplay')}</p>}
      <div className="flex flex-wrap gap-2">
        {job.replayable && (
          <button className="button" disabled={replay.isPending} onClick={() => replay.mutate()}>
            {t('replay')}
          </button>
        )}
        <button className="button-quiet" disabled={dismiss.isPending} onClick={() => dismiss.mutate()}>
          {t('dismiss')}
        </button>
      </div>
      <Failure error={replay.error ?? dismiss.error} />
    </li>
  );
}
