#!/usr/bin/env node
'use strict';
const { load, card, behaviors } = require('./catalog');
const data = load(), [command, value] = process.argv.slice(2);
let result;
if (command === 'show' && value) result = card(value, data);
else if (command === 'behaviors') result = behaviors(data);
else if (command === 'behavior' && value) {
    const all = behaviors(data), capability = all.capabilities.find(b => b.id === value), family = all.testFamilies.find(b => b.id === value);
    if (!capability && !family) throw new Error('Unknown behavior: ' + value);
    result = { capability: capability ?? null, testFamily: family ?? null };
}
else if (command === 'list') result = data.compiled.cards.map(c => ({ setCode: c.setCode, title: c.card.title, converted: data.inventory.cards.find(s => s.setCode === c.setCode).converted, admitted: data.inventory.cards.find(s => s.setCode === c.setCode).admitted, behaviors: c.requiredCapabilities }));
else if (!command || command === 'summary') result = { cards: data.inventory.cards.length, converted: data.inventory.cards.filter(c => c.converted).length, admitted: data.inventory.cards.filter(c => c.admitted).length, definedCases: data.cases.cases.length, recordedCases: new Set(data.corpus.recordings.map(r => r.caseId)).size, recordings: data.corpus.recordings.length };
else throw new Error('Usage: cards [summary | list | show SET_NNN | behaviors | behavior ID]');
console.log(JSON.stringify(result, null, 2));
