import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <main style={{ padding: 16, fontFamily: 'system-ui' }}>
      <h1>聽見廣播</h1>
      <p>專案骨架（第 1 階段）：數據機核心位於 src/modem/。</p>
    </main>
  </StrictMode>,
);
