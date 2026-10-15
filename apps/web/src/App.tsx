import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Link, Outlet, RouterProvider, createBrowserRouter, useParams } from 'react-router-dom';
import { shouldRetry, useMeta } from './api/queries';
import { AuthControl } from './components/AuthControl';
import { ErrorBoundary } from './components/ErrorBoundary';
import { EmptyState } from './components/Feedback';
import { ToastProvider } from './components/Toasts';
import { CivilizationsPage } from './pages/civilizations/CivilizationsPage';
import { DashboardPage } from './pages/dashboard/DashboardPage';
import { ObservatoryPage } from './pages/observatory/ObservatoryPage';

/*
 * Application root: data client, notifications, routing and the global chrome.
 */

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: shouldRetry, refetchOnWindowFocus: false, staleTime: 2_000 },
      mutations: { retry: false },
    },
  });
}

function Shell() {
  const meta = useMeta();
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="app-header">
        <Link to="/" className="brand" aria-label="Civilization Observatory — all civilizations">
          <svg viewBox="0 0 32 32" width="22" height="22" aria-hidden="true">
            <rect
              x="7"
              y="4"
              width="18"
              height="24"
              rx="5"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
            />
            <circle cx="16" cy="19" r="4" className="brand-dot" />
          </svg>
          <span>Civilization Observatory</span>
        </Link>
        <div className="app-header-end">
          {meta.data && (
            <span className="muted small" title="Simulation engine version">
              engine {meta.data.engineVersion}
            </span>
          )}
          {meta.isError && <span className="small text-danger">Server unreachable</span>}
          <AuthControl />
        </div>
      </header>
      <main id="main" className="app-main">
        <ErrorBoundary area="Page">
          <Outlet />
        </ErrorBoundary>
      </main>
    </div>
  );
}

function ObservatoryRoute() {
  const { id = '' } = useParams();
  return <ObservatoryPage key={id} civilizationId={id} />;
}

function DashboardRoute() {
  const { id = '' } = useParams();
  return <DashboardPage key={id} civilizationId={id} />;
}

function NotFound() {
  return (
    <div className="page">
      <EmptyState title="Page not found">
        <Link to="/">Back to civilizations</Link>
      </EmptyState>
    </div>
  );
}

const router = createBrowserRouter([
  {
    element: <Shell />,
    children: [
      { path: '/', element: <CivilizationsPage /> },
      { path: '/civ/:id', element: <ObservatoryRoute /> },
      { path: '/civ/:id/dashboard', element: <DashboardRoute /> },
      { path: '*', element: <NotFound /> },
    ],
  },
]);

const queryClient = createQueryClient();

export function App() {
  return (
    <ErrorBoundary area="Application">
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <RouterProvider router={router} />
        </ToastProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}
