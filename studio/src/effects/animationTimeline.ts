import { useEffect, useRef, useState } from 'react';
import { createTimeline } from 'animejs';

export const clamp = (value: number) => Math.max(0, Math.min(1, value));
export const phase = (progress: number, from: number, to: number) => clamp((progress - from) / (to - from));
export const easeOut = (value: number) => 1 - (1 - clamp(value)) ** 3;
export const easeInOut = (value: number) => { const p = clamp(value); return p * p * (3 - 2 * p); };
export const envelope = (progress: number, from: number, peak: number, to: number) => progress < peak ? easeOut(phase(progress, from, peak)) : 1 - phase(progress, peak, to);

/** Live playback and the inspection scrubber share one exact, reversible Anime.js clock. */
export function useAnimationProgress(duration: number, seek: number | undefined, onComplete?: () => void) {
    const [progress, setProgress] = useState(seek == null ? 0 : clamp(seek));
    const timeline = useRef<ReturnType<typeof createTimeline> | null>(null);
    const latestSeek = useRef(seek);
    const complete = useRef(onComplete);
    latestSeek.current = seek;
    complete.current = onComplete;

    useEffect(() => {
        const clock = { progress: 0 };
        const playback = createTimeline({
            autoplay: false,
            onUpdate: () => setProgress(clamp(clock.progress)),
            onComplete: () => { if (latestSeek.current == null) complete.current?.(); },
        }).add(clock, { progress: [0, 1], duration, ease: 'linear' }, 0);
        timeline.current = playback;
        if (latestSeek.current == null) playback.play();
        else {
            const position = clamp(latestSeek.current);
            playback.seek(position * duration, true);
            setProgress(position);
        }
        return () => { playback.revert(); timeline.current = null; };
    }, [duration]);

    useEffect(() => {
        const playback = timeline.current;
        if (!playback) return;
        if (seek == null) {
            playback.play();
        } else {
            playback.pause();
            const position = clamp(seek);
            playback.seek(position * duration, true);
            setProgress(position);
        }
    }, [seek, duration]);
    return progress;
}
