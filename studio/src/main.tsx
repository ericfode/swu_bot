import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MotionConfig } from 'motion/react';
import { Shell } from './components/Shell';
import { GamePage } from './pages/GamePage';
import { HomePage } from './pages/HomePage';
import { TournamentPage } from './pages/TournamentPage';
import { useRoute } from './lib/route';
import './styles.css';

function App() {
    const route = useRoute();
    return (
        <MotionConfig reducedMotion="user">
            <Shell route={route}>
                {route.page === 'home' && <HomePage />}
                {route.page === 'tournament' && <TournamentPage key={route.tid} tid={route.tid} />}
                {route.page === 'game' && <GamePage key={`${route.tid}/${route.gid}`} tid={route.tid} gid={route.gid} startStep={route.step} />}
            </Shell>
        </MotionConfig>
    );
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
