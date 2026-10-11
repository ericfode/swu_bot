import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MotionConfig } from 'motion/react';
import { Shell } from './components/Shell';
import { GamePage } from './pages/GamePage';
import { HomePage } from './pages/HomePage';
import { TournamentPage } from './pages/TournamentPage';
import { IconsPage } from './pages/IconsPage';
import { useRoute } from './lib/route';
import { loadArtPack } from './lib/cards';
import { createSettingsStore, SettingsProvider } from './lib/settings';
import './styles.css';

// The static build can't reach the image CDN (published pages block external images); it ships art-pack.json beside the page.
if (import.meta.env.MODE === 'static') {
    loadArtPack('./art-pack.json').catch(() => undefined);
}

const settings = createSettingsStore('holotable.settings');

function App() {
    const route = useRoute();
    return (
        <MotionConfig reducedMotion="user">
            <Shell route={route}>
                {route.page === 'home' && <HomePage />}
                {route.page === 'tournament' && <TournamentPage key={route.tid} tid={route.tid} />}
                {route.page === 'icons' && <IconsPage tid={route.tid} gid={route.gid} />}
                {route.page === 'game' && <GamePage key={`${route.tid}/${route.gid}`} tid={route.tid} gid={route.gid} startStep={route.step} />}
            </Shell>
        </MotionConfig>
    );
}

createRoot(document.getElementById('root')!).render(<StrictMode><SettingsProvider store={settings}><App /></SettingsProvider></StrictMode>);
