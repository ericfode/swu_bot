import type { Chance, ScoreSource, ScoreStep } from '../data/score';

/** The chance state in words, as the badge, the picker and the tooltips write it. */
export const CHANCE_WORD: Record<Chance, string> = { fitted: 'fitted', model: 'own chance', rough: 'rough guess', none: 'not calibrated' };

/** Where a step's values come from, in a word or two. */
function statusWord(source: ScoreSource, step: ScoreStep | null | undefined): string | null {
    if (!step) {
        return source.origin === 'estimate' ? null : 'file';
    }
    switch (step.status) {
        case 'file': return 'file';
        // the estimate's label already says "estimated here"
        case 'estimate': return source.label.includes('estimated here') ? null : 'estimated here';
        case 'held': return `as of step ${step.heldFromN}`;
        case 'missing': return 'no value here';
        case 'mismatch': return 'doesn\'t match the board';
    }
}

/** A weight set for a badge: its key when short ("R7+"), else its label */
export const shortSet = (source: ScoreSource, set: string) => (set.length <= 6 ? set : setLabel(source, set));

/** A weight set's label ("Rounds 4-6"), else its key. */
export const setLabel = (source: ScoreSource, set: string) => source.weightSets[set]?.label ?? set;

/** The weights in force, when the source's weights change during a game: the set ("weights R4-6") or "weights per step". */
function weightsWord(source: ScoreSource, step: ScoreStep | null | undefined): string | null {
    if (step?.weightSet) {
        return `weights ${shortSet(source, step.weightSet)}`;
    }
    return source.constantWeights ? null : 'weights per step';
}

/** The badge's parts: label, unit, chance state, where the values come from, and the weights in force when they vary. */
export function badgeParts(source: ScoreSource, step?: ScoreStep | null): string[] {
    if (source.error) {
        return [source.label, 'not read'];
    }
    return [source.label, source.unitText, CHANCE_WORD[source.chance], statusWord(source, step), weightsWord(source, step)].filter((x): x is string => !!x);
}

/** "Omni v1 · points · rough guess · file · weights R4-6": goes into the tooltip of every number drawn from a score. */
export const badgeText = (source: ScoreSource, step?: ScoreStep | null) => badgeParts(source, step).join(' · ');

/** Which score a number comes from, and how far to trust it, as one small chip. */
export function ScoreBadge({ source, step, className = '' }: { source: ScoreSource; step?: ScoreStep | null; className?: string }) {
    const text = badgeText(source, step);
    return (
        <span className={`chip !text-[10.5px] max-w-full min-w-0 ${className}`} title={source.description ? `${text}\n${source.description}` : text}>
            <span className="truncate">{text}</span>
        </span>
    );
}
