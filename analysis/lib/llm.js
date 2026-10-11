'use strict';

/**
 * Claude evaluator. Takes request objects { id, system, user, schema, effort, maxTokens } and returns
 * Map<id, { output, usage, model, cached, error }>.
 *
 * - Direct mode: concurrent streaming calls with server-side refusal fallbacks.
 * - Batch mode (--batch): one Message Batch, 50% cheaper, results usually within the hour.
 * - Every successful answer is cached on disk by a hash of (model, effort, prompt, schema), so re-running an
 *   analysis, or re-rendering it with a new chart, costs nothing.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_MODEL = 'claude-opus-5-5';

// $ per million tokens (input, output, cache read, cache write). Batch is half of these.
const PRICES = {
    'claude-opus-5-5': [4, 20, 0.2, 5],
    'claude-sonnet-5-5': [2, 10, 0.2, 2.5],
    'claude-haiku-5-5': [0.1, 0.5, 0.01, 0.125],
    'claude-fable-5-1': [10, 50, 0.25, 12.5]
};

function cost(model, usage, batch) {
    const p = PRICES[model];
    if (!p || !usage) {
        return null;
    }
    const usd = ((usage.input_tokens ?? 0) * p[0] + (usage.output_tokens ?? 0) * p[1] + (usage.cache_read_input_tokens ?? 0) * p[2] + (usage.cache_creation_input_tokens ?? 0) * p[3]) / 1e6;
    return batch ? usd / 2 : usd;
}

function cacheKey(model, req) {
    return crypto.createHash('sha256').update(JSON.stringify([model, req.effort, req.system, req.user, req.schema])).digest('hex').slice(0, 32);
}

class DiskCache {
    constructor(dir) {
        this.dir = dir;
        if (dir) {
            fs.mkdirSync(dir, { recursive: true });
        }
    }

    get(key) {
        if (!this.dir) {
            return null;
        }
        const f = path.join(this.dir, `${key}.json`);
        return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
    }

    set(key, value) {
        if (this.dir) {
            fs.writeFileSync(path.join(this.dir, `${key}.json`), JSON.stringify(value));
        }
    }
}

function parseOutput(msg) {
    if (msg.stop_reason === 'refusal') {
        throw new Error(`refused${msg.stop_details?.category ? ` (${msg.stop_details.category})` : ''}`);
    }
    if (msg.stop_reason === 'max_tokens') {
        throw new Error('hit max_tokens');
    }
    const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    return JSON.parse(text);
}

function params(model, req) {
    return {
        model,
        max_tokens: req.maxTokens ?? 16000,
        thinking: { type: 'adaptive' },
        output_config: { effort: req.effort, format: { type: 'json_schema', schema: req.schema } },
        system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: req.user }]
    };
}

async function pool(items, n, fn) {
    let next = 0;
    const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
        while (next < items.length) {
            const item = items[next++];
            await fn(item);
        }
    });
    await Promise.all(workers);
}

class ClaudeEvaluator {
    /**
     * @param {object} o
     * @param {string} [o.model]
     * @param {number} [o.concurrency]
     * @param {boolean} [o.batch]
     * @param {string|null} [o.cacheDir]
     * @param {object} [o.client] an Anthropic client (injected in tests)
     */
    constructor({ model = DEFAULT_MODEL, concurrency = 8, batch = false, cacheDir = null, client = null, log = console.error } = {}) {
        this.model = model;
        this.concurrency = concurrency;
        this.batch = batch;
        this.cache = new DiskCache(cacheDir);
        this.log = log;
        if (client) {
            this.client = client;
        } else {
            const Anthropic = require('@anthropic-ai/sdk');
            // credentials: ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN or an `ant auth login` profile
            this.client = new Anthropic();
        }
        this.kind = 'llm';
    }

    describe() {
        return { kind: 'llm', model: this.model, batch: this.batch };
    }

    async run(requests) {
        const results = new Map();
        const todo = [];
        for (const req of requests) {
            const hit = this.cache.get(cacheKey(this.model, req));
            if (hit) {
                results.set(req.id, { ...hit, cached: true });
            } else {
                todo.push(req);
            }
        }
        this.log(`claude: ${requests.length} requests, ${requests.length - todo.length} cached, ${todo.length} to run${todo.length && this.batch ? ' (batch)' : ''}`);
        if (!todo.length) {
            return results;
        }
        if (this.batch) {
            await this.runBatch(todo, results);
        } else {
            await this.runDirect(todo, results);
        }
        return results;
    }

    store(req, msg, results, batch) {
        try {
            const output = parseOutput(msg);
            const value = { output, usage: msg.usage, model: msg.model, cost: cost(this.model, msg.usage, batch) };
            this.cache.set(cacheKey(this.model, req), value);
            results.set(req.id, value);
        } catch (e) {
            results.set(req.id, { error: String(e.message ?? e), usage: msg.usage, model: msg.model });
        }
    }

    async runDirect(todo, results) {
        const Anthropic = require('@anthropic-ai/sdk');
        let done = 0;
        await pool(todo, this.concurrency, async (req) => {
            try {
                const stream = this.client.beta.messages.stream({
                    ...params(this.model, req),
                    // on a policy decline, re-run on a fallback model chosen by refusal category
                    betas: ['server-side-fallback-2026-07-01'],
                    fallbacks: 'default'
                });
                const msg = await stream.finalMessage();
                this.store(req, msg, results, false);
            } catch (e) {
                if (e instanceof Anthropic.AuthenticationError) {
                    throw new Error('Claude API authentication failed: set ANTHROPIC_API_KEY (or run `ant auth login`)');
                }
                results.set(req.id, { error: e instanceof Anthropic.APIError ? `API ${e.status}: ${e.message}` : String(e.message ?? e) });
            }
            done++;
            if (done % 10 === 0 || done === todo.length) {
                this.log(`claude: ${done}/${todo.length}`);
            }
        });
    }

    async runBatch(todo, results) {
        const byId = new Map(todo.map((r) => [r.id, r]));
        const batch = await this.client.messages.batches.create({
            requests: todo.map((req) => ({ custom_id: req.id, params: params(this.model, req) }))
        });
        this.log(`claude: batch ${batch.id} created`);
        let b = batch;
        while (b.processing_status !== 'ended') {
            await new Promise((r) => setTimeout(r, 30_000));
            b = await this.client.messages.batches.retrieve(batch.id);
            this.log(`claude: batch ${b.processing_status}, ${b.request_counts.succeeded} ok, ${b.request_counts.processing} processing`);
        }
        for await (const r of await this.client.messages.batches.results(batch.id)) {
            const req = byId.get(r.custom_id);
            if (!req) {
                continue;
            }
            if (r.result.type === 'succeeded') {
                this.store(req, r.result.message, results, true);
            } else {
                results.set(req.id, { error: `batch ${r.result.type}${r.result.error ? `: ${JSON.stringify(r.result.error)}` : ''}` });
            }
        }
    }
}

/**
 * Answers produced elsewhere (any model, a human, a Claude Code session) for requests written with --dump-prompts.
 * File: one JSON object per line, { "id": "...", "output": { ...schema... } }.
 */
class AnswerFileEvaluator {
    constructor(files, label = 'external') {
        this.label = label;
        this.answers = new Map();
        for (const f of files) {
            for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
                if (line.trim()) {
                    const a = JSON.parse(line);
                    this.answers.set(a.id, a);
                }
            }
        }
        this.kind = 'external';
    }

    describe() {
        return { kind: 'external', model: this.label };
    }

    async run(requests) {
        const results = new Map();
        for (const req of requests) {
            const a = this.answers.get(req.id);
            results.set(req.id, a ? { output: a.output, model: a.model ?? this.label } : { error: 'no answer in file' });
        }
        return results;
    }
}

module.exports = { ClaudeEvaluator, AnswerFileEvaluator, DEFAULT_MODEL, cost, cacheKey };
