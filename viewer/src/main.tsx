import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { SettingsProvider } from './core/settings';
import { useRoute } from './core/useRoute';
import { GamePage, HomePage, TournamentPage } from './pages/Pages';
import './styles.css';

function App() {
    const route = useRoute();
    return (
        <>
            <header className="topbar">
                <a className="brand" href="#/">SWU Bot Replays</a>
            </header>
            <main>
                {route.page === 'home' && <HomePage />}
                {route.page === 'tournament' && <TournamentPage key={route.tid} tid={route.tid} />}
                {route.page === 'game' && <GamePage key={`${route.tid}/${route.gid}`} tid={route.tid} gid={route.gid} step={route.step} />}
            </main>
        </>
    );
}

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <SettingsProvider>
            <App />
        </SettingsProvider>
    </StrictMode>
);
