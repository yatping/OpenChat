/**
 * Structured logging with an allowlist. A sensitive value has to be deliberately added to LogFields
 * before it can be logged: unknown keys fail to compile for object literals, and are dropped at runtime.
 */
export interface LogFields {
  requestId?: string;
  installationId?: string;
  workspaceId?: string;
  route?: string;
  method?: string;
  status?: number;
  durationMs?: number;
  queue?: string;
  jobType?: string;
  jobId?: string;
  attempts?: number;
  count?: number;
  errorName?: string;
  errorCode?: string;
}

const ALLOWED = new Set<string>([
  'requestId',
  'installationId',
  'workspaceId',
  'route',
  'method',
  'status',
  'durationMs',
  'queue',
  'jobType',
  'jobId',
  'attempts',
  'count',
  'errorName',
  'errorCode',
] satisfies (keyof LogFields)[]);

export type LogLevel = 'info' | 'warn' | 'error';
export type LogSink = (line: string) => void;

export interface Logger {
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

function clean(fields: LogFields): LogFields {
  return Object.fromEntries(Object.entries(fields).filter(([key]) => ALLOWED.has(key))) as LogFields;
}

export function createLogger(base: LogFields = {}, sink: LogSink = console.log): Logger {
  const write = (level: LogLevel, event: string, fields: LogFields = {}) =>
    sink(JSON.stringify({ level, event, time: new Date().toISOString(), ...clean(base), ...clean(fields) }));
  return {
    info: (event, fields) => write('info', event, fields),
    warn: (event, fields) => write('warn', event, fields),
    error: (event, fields) => write('error', event, fields),
    child: (fields) => createLogger({ ...base, ...fields }, sink),
  };
}
