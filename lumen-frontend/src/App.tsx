import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './auth/AuthContext';
import { ProtectedRoute } from './auth/ProtectedRoute';
import { AdminRoute } from './auth/AdminRoute';
import { AppShell } from './components/AppShell';
import { LoginPage } from './routes/LoginPage';
import { RegisterPage } from './routes/RegisterPage';
import { LibraryPage } from './routes/LibraryPage';
import { BookDetailPage } from './routes/BookDetailPage';
import { UploadPage } from './routes/UploadPage';
import { JobStatusPage } from './routes/JobStatusPage';
import { ReaderPage } from './routes/ReaderPage';
import { PlayerPage } from './routes/PlayerPage';
import { SettingsPage } from './routes/SettingsPage';
import { CharacterScenePage } from './routes/CharacterScenePage';
import { AdminVoicesPage } from './routes/AdminVoicesPage';
import { AdminDashboardPage } from './routes/AdminDashboardPage';
import { AdminUsersPage } from './routes/AdminUsersPage';
import { AdminAuditLogPage } from './routes/AdminAuditLogPage';

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />

          <Route element={<ProtectedRoute />}>
            <Route element={<AppShell />}>
              <Route path="/" element={<LibraryPage />} />
              <Route path="/upload" element={<UploadPage />} />
              <Route path="/books/:bookId" element={<BookDetailPage />} />
              <Route path="/books/:bookId/jobs/:jobId" element={<JobStatusPage />} />
              <Route path="/books/:bookId/read" element={<ReaderPage />} />
              <Route path="/books/:bookId/listen" element={<PlayerPage />} />
              <Route path="/books/:bookId/characters" element={<CharacterScenePage />} />
              <Route path="/settings" element={<SettingsPage />} />

              <Route element={<AdminRoute />}>
                <Route path="/admin/dashboard" element={<AdminDashboardPage />} />
                <Route path="/admin/users" element={<AdminUsersPage />} />
                <Route path="/admin/audit-log" element={<AdminAuditLogPage />} />
                <Route path="/admin/voices" element={<AdminVoicesPage />} />
              </Route>
            </Route>
          </Route>

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
