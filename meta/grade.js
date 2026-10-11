'use strict';

/** Grades reviewer answers against the quiz key: node meta/grade.js <quiz.json> <answers.json>...  (answers: {id: "text"}) */
const fs = require('fs');

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9+.\- ]/g, ' ');
const has = (text, name) => new RegExp(`(^|[^a-z0-9+.-])${norm(name).trim().replace(/[.+]/g, '\\$&')}($|[^a-z0-9+-])`).test(norm(text));

function grade(quiz, answers) {
    const rows = quiz.questions.map((q) => {
        const a = answers[q.id] || '';
        let ok;
        if (q.kind === 'all-of') ok = q.key.length ? q.key.filter((k) => has(a, k)).length / q.key.length : (/none|no bot/i.test(a) ? 1 : 0);
        else ok = q.key.some((k) => has(a, k)) ? 1 : 0;
        return { id: q.id, ok, answer: a, key: q.key };
    });
    // Essence: share of spot groups (behind / close or long / ahead) whose winning bot the takeaway names.
    let essence = null;
    if (quiz.essence && answers.essence) {
        const groups = Object.values(quiz.essence);
        essence = groups.filter((names) => names.some((n) => has(answers.essence, n))).length / groups.length;
    }
    return { score: rows.reduce((s, r) => s + r.ok, 0) / rows.length, essence, rows };
}

if (require.main === module) {
    const [quizFile, ...files] = process.argv.slice(2);
    const quiz = JSON.parse(fs.readFileSync(quizFile, 'utf8'));
    const all = [];
    for (const f of files) {
        const a = JSON.parse(fs.readFileSync(f, 'utf8'));
        const g = grade(quiz, { ...(a.answers || {}), essence: a.essence });
        all.push(g.score);
        console.log(`${f}: quiz ${(g.score * 100).toFixed(0)}%${g.essence != null ? `, essence ${(g.essence * 100).toFixed(0)}%` : ''}`);
        for (const r of g.rows) if (r.ok < 1) console.log(`   miss ${r.id}: said "${String(r.answer).slice(0, 80)}" key ${r.key.join(' | ')}`);
    }
    console.log(`mean ${(100 * all.reduce((a, b) => a + b, 0) / all.length).toFixed(0)}%`);
}
module.exports = { grade };
