import { createClient } from '@openchat/api-client';
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

const client = createClient({ baseUrl: window.location.origin });

function App() {
  const [status, setStatus] = useState('checking');
  useEffect(() => {
    client.getHealth().then(
      (health) => setStatus(health.status),
      () => setStatus('unavailable'),
    );
  }, []);
  return (
    <main>
      <h1>OpenChat</h1>
      <p>API status: {status}</p>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
