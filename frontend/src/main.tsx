import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import ErrorBoundary from './components/ErrorBoundary';
import './index.css';
import DemoBanner from './mock/DemoBanner';
import { installMockApi } from './mock/mockApi';

// 백엔드가 없는 포트폴리오 데모 — VITE_MOCK_API=false 일 때만 실제 API를 호출한다.
const USE_MOCK_API = import.meta.env.VITE_MOCK_API !== 'false';
if (USE_MOCK_API) installMockApi();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {USE_MOCK_API && <DemoBanner />}
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>
);
