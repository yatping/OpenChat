import { useSyncExternalStore } from 'react';
import { connections } from './native';

export const useConnections = () => useSyncExternalStore(connections.subscribe, connections.getState);
