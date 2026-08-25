import { Link } from 'react-router-dom';
import type { Book } from '../api/books';

function statusBadgeClass(status: string): string {
  if (status === 'ready') return 'badge badge-ready';
  if (status === 'failed') return 'badge badge-failed';
  return 'badge badge-processing';
}

export function BookCard({ book }: { book: Book }) {
  return (
    <Link
      to={`/books/${book.id}`}
      className="card"
      style={{ display: 'block', textDecoration: 'none', color: 'inherit', transition: 'border-color 0.15s ease' }}
    >
      <h3 style={{ fontSize: 18, marginBottom: 6 }}>{book.title}</h3>
      <p style={{ color: 'var(--text-dim)', fontSize: 14, marginBottom: 14 }}>{book.author ?? 'Unknown author'}</p>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
        <span className={statusBadgeClass(book.status)}>{book.status}</span>
        <span style={{ color: 'var(--text-faint)' }}>
          {book.chapterCount} chapters &middot; {book.segmentCount} segments
        </span>
      </div>
    </Link>
  );
}
