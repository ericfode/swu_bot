'use strict';
/**
 * How many real people our Karabast runs have touched, with a hard cap. Eric's limit for the pilot (2026-10-11): no
 * more than 10 real users. Every opponent of a bot game and both players of a watched game count, once each, from
 * the moment we are matched with them or join their game.
 *
 * The file keeps no ids or names: only salted SHA-256 digests (the salt is made once and kept in the file), so it can
 * say "already counted" without saying who. It is written with a temporary file and a rename after each change.
 *
 * Several runs may share one file (a bot run and a recorder at the same time). Each check reads the file again, and
 * add() reads, checks and writes while holding a lock file, so two processes on one machine cannot both take the
 * last place under the cap.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');


function sleepSync(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

class PeopleLedger {
    constructor(file, max = 10, { lockWaitMs = 10000 } = {}) {
        this.file = file;
        this.max = max;
        this.lockWaitMs = lockWaitMs;
        this.load();
    }

    load() {
        this.data = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : { salt: crypto.randomBytes(16).toString('hex'), people: {} };
    }

    digest(userId) {
        return crypto.createHash('sha256').update(`${this.data.salt}:${userId}`).digest('hex').slice(0, 24);
    }

    get count() {
        return Object.keys(this.data.people).length;
    }

    /** True when `n` more new people fit under the cap, by the file as it is now. */
    room(n = 1) {
        this.load();
        return this.count + n <= this.max;
    }

    has(userId) {
        return Object.hasOwn(this.data.people, this.digest(userId));
    }

    /** Counts `userIds` (what: 'played' or 'watched'); returns how many were new. Throws past the cap. */
    add(userIds, what) {
        return this.locked(() => {
            const fresh = [...new Set(userIds)].filter((id) => !this.has(id));
            if (this.count + fresh.length > this.max) {
                throw new Error(`people cap reached: ${this.count} of ${this.max} counted, ${fresh.length} more would pass it`);
            }
            const at = new Date().toISOString();
            for (const id of fresh) {
                this.data.people[this.digest(id)] = { at, what };
            }
            this.save();
            return fresh.length;
        });
    }

    /**
     * Runs fn on the file's current data while holding `<file>.lock` (created exclusively). A lock is never taken
     * over: one left by a run that died stops the next run, which says which file to remove.
     */
    locked(fn) {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        const lock = `${this.file}.lock`;
        const t0 = Date.now();
        let fd;
        for (;;) {
            try {
                fd = fs.openSync(lock, 'wx');
                break;
            } catch (e) {
                if (e.code !== 'EEXIST') {
                    throw e;
                }
            }
            if (Date.now() - t0 > this.lockWaitMs) {
                throw new Error(`people ledger ${this.file} stayed locked for ${this.lockWaitMs / 1000} s; if no other run is using it, remove ${lock}`);
            }
            sleepSync(50);
        }
        try {
            this.load();
            return fn();
        } finally {
            fs.closeSync(fd);
            fs.rmSync(lock, { force: true });
        }
    }

    save() {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        const tmp = `${this.file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(this.data, null, 1));
        fs.renameSync(tmp, this.file);
    }
}

module.exports = { PeopleLedger };
