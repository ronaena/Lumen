import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { listBooks, type Book } from '../api/books';
import { ApiError } from '../api/client';
import { LoadingState, EmptyState, ErrorBanner } from '../components/States';
import { BookCard } from '../components/BookCard';

export function LibraryPage() {
  const [books, setBooks] = useState<Book[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setBooks(await listBooks());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load your library.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  if (loading) return <LoadingState label="Loading your library" />;
  if (error) return <ErrorBanner message={error} onRetry={() => void load()} />;

  if (!books || books.length === 0) {
    return (
      <EmptyState
        title="Your library is empty"
        description="Upload an EPUB to start turning it into a narrated audiobook."
        action={
          <Link to="/upload" className="btn btn-primary">
            Upload a book
          </Link>
        }
      />
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <h1 style={{ fontSize: 24 }}>Your library</h1>
        <Link to="/upload" className="btn btn-primary">
          Upload a book
        </Link>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 16 }}>
        {books.map((book) => (
          <BookCard key={book.id} book={book} />
        ))}
      </div>
    </div>
  );
}
