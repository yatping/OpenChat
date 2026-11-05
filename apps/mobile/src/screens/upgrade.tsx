import { Problem } from '../ui/kit';

export function UpgradeMessage({ name, compatibility }: { name: string; compatibility: 'update_app' | 'update_installation' }) {
  return <Problem>{compatibility === 'update_app' ? `${name} needs a newer version of this app. Please update the app.` : `${name} is running an older version than this app supports. Please ask its administrator to upgrade it.`}</Problem>;
}
