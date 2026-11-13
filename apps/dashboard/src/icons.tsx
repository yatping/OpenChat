/** Line icons drawn for OpenChat, on a 24-pixel grid. Decorative: whatever holds one carries the words. */
const PATHS = {
  inbox: 'M4 5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-8l-5 4v-4H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM8 10h8M8 13h5',
  websites: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z',
  members: 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2.5 20c.6-3.4 3.2-5.5 6.5-5.5s5.9 2.1 6.5 5.5M16 4.3a3.5 3.5 0 0 1 0 6.4M18.5 14.8c1.6.8 2.7 2.6 3 5.2',
  email: 'M3.5 6h17a.5.5 0 0 1 .5.5v11a.5.5 0 0 1-.5.5h-17a.5.5 0 0 1-.5-.5v-11a.5.5 0 0 1 .5-.5zM3.5 6.5 12 13l8.5-6.5',
  people: 'M10 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM3.5 20c.6-3.4 3.2-5.5 6.5-5.5 1.3 0 2.5.3 3.5.9M18 14v2m0 4v.01M18 13.5l3.5 6.5h-7z',
  workspaces: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
  jobs: 'M12 3.5 21.5 20h-19zM12 10v4.5M12 17.2v.01',
  audit: 'M8 4h8v3H8zM6 5.5H5a1 1 0 0 0-1 1V20a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V6.5a1 1 0 0 0-1-1h-1M8 12h8M8 16h5',
  signOut: 'M14 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4M10 16l-4-4 4-4M6 12h9',
  send: 'M4 12 20 4l-6 16-3-7zM11 13l9-9',
  attach: 'M20 11.5 12.3 19.2a5 5 0 0 1-7-7L13 4.5a3.3 3.3 0 0 1 4.7 4.7L10 16.9a1.7 1.7 0 0 1-2.4-2.4L14.8 7.3',
  back: 'M15 5l-7 7 7 7',
  person: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4.5 20.5c.8-3.8 3.7-6 7.5-6s6.7 2.2 7.5 6',
  chat: 'M12 4c4.4 0 8 3 8 6.8s-3.6 6.7-8 6.7c-1 0-2-.2-2.9-.4L5 19l1-3.6C4.8 14.2 4 12.6 4 10.8 4 7 7.6 4 12 4z',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, className = 'size-5' }: { name: IconName; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d={PATHS[name]} />
    </svg>
  );
}

/** Up to two initials, or an outline of a person for someone with no name. */
export function Initials({ name }: { name: string | null | undefined }) {
  const letters = initials(name);
  return letters ? <>{letters}</> : <Icon name="person" className="size-[55%]" />;
}

/** Up to two initials, for an avatar. Empty for someone with no name. */
export function initials(name: string | null | undefined): string {
  const words = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '';
  const first = [...words[0]!][0] ?? '';
  const last = words.length > 1 ? ([...words[words.length - 1]!][0] ?? '') : '';
  return (first + last).toUpperCase();
}
