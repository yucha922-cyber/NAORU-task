import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { Layout } from './components/Layout'
import { AppProvider, useApp } from './lib/app'
import { CalendarPage } from './pages/Calendar'
import { Home } from './pages/Home'
import { Login, NoStore } from './pages/Login'
import { MyTasks } from './pages/MyTasks'
import { Settings } from './pages/Settings'
import { Team } from './pages/Team'

function Shell() {
  const { user, loading, store } = useApp()
  if (loading) return <div className="flex min-h-dvh items-center justify-center text-sm text-neutral-400">読み込み中…</div>
  if (!user) return <Login />
  if (!store) return <NoStore />
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/tasks" element={<MyTasks />} />
        <Route path="/calendar" element={<CalendarPage />} />
        <Route path="/team" element={<Team />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="*" element={<Navigate to="/" />} />
      </Routes>
    </Layout>
  )
}

export default function App() {
  return (
    <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, "") || "/"}>
      <AppProvider><Shell /></AppProvider>
    </BrowserRouter>
  )
}
