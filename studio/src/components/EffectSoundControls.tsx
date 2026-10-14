import { useState } from 'react';
import { Volume2, VolumeX } from 'lucide-react';
import { unlockEffectAudio } from '../effects/audio';
import { useSettings } from '../lib/settings';

/** Enabling sound is also the browser's required audio-unlock gesture. */
export function EffectSoundControls({ onEnabled }: { onEnabled?: () => void }) {
    const { sound, volume, setSound, setVolume } = useSettings();
    const [unlocking, setUnlocking] = useState(false);
    const [unavailable, setUnavailable] = useState(false);
    async function toggle() {
        if (sound) { setSound(false); return; }
        setUnlocking(true);
        const enabled = await unlockEffectAudio();
        setUnlocking(false);
        setUnavailable(!enabled);
        if (enabled) { setSound(true); onEnabled?.(); }
    }
    return <div className="flex items-center gap-2">
        <button className="btn !h-8 !px-2" onClick={toggle} disabled={unlocking} aria-pressed={sound} aria-label={sound ? 'Mute sound effects' : 'Enable sound effects'} title={unavailable ? 'Audio could not start. Try enabling sound again.' : 'Original synthesized card sound effects'}>
            {sound ? <Volume2 size={15} /> : <VolumeX size={15} />}<span>{sound ? 'Sound on' : 'Sound off'}</span>
        </button>
        {sound && <label className="flex items-center gap-1 text-[10px] text-dim"><input style={{ width: 65, accentColor: 'var(--ce-color, #b1d5f5)' }} aria-label="Effect volume" type="range" min="0" max="100" step="5" value={Math.round(volume * 100)} onChange={e => setVolume(Number(e.target.value) / 100)} /><span className="num">{Math.round(volume * 100)}%</span></label>}
        {unavailable && <span role="status" className="text-xs text-dim">Audio unavailable</span>}
    </div>;
}
