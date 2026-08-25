export function LoadingState({ label = 'Loading' }: { label?: string }) {
  return (
    <div style={{ padding: '48px 24px', textAlign: 'center', color: 'var(--text-dim)' }}>
      <span aria-live="polite">{label}&hellip;</span>
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="empty-state">
      <h3 style={{ color: 'var(--text)', marginBottom: 8 }}>{title}</h3>
      {description && <p style={{ marginBottom: 20 }}>{description}</p>}
      {action}
    </div>
  );
}

export function ErrorBanner({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="error-banner">
      <p style={{ margin: 0 }}>{message}</p>
      {onRetry && (
        <button className="btn btn-ghost" style={{ marginTop: 8, padding: '6px 12px' }} onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}
