'use strict';
/**
 * How many real people our Karabast runs have touched, with a hard cap. Eric's limit for the pilot (2026-10-11): no
 * more than 10 real users. Every opponent of a bot game and both players of a watched game count, once each, from
 * the moment we are matched with them or join their game.
 *
 * The file keeps no ids or names: only salted SHA-256 digests (the salt is made once and kept in the file), so it can
 * say "already counted" without saying who. It is written with a temporary file and a rename after each change.
 *
 * Several runs may share one file (a bot run and a recorder at the same time). A run reserves its places before it
 * contacts anyone (reserve(), 1 for a bot game, 2 for a watched game), counts the people once it knows them
 * (add() with the reservation) and gives back what it did not use (release()), or counts it anyway when it may have
 * been seen without learning who saw it (spend()). Reservations count against the cap,
 * so two runs cannot both take the last place. Every change reads, checks and writes while holding a lock file, and
 * every check reads the file again. A run that dies keeps its reservation in the file, which only makes the cap
 * stricter; remove it from `held` by hand.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function sleepSync(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

class PeopleLedger {
    constructor(file, max = 10, { lockWaitMs = 10000 } = {}) {
        // a typo in --max-people gives NaN, and every check against NaN passes: refuse it rather than run uncapped
        if (!Number.isInteger(max) || max < 0) {
            throw new Error(`people cap must be a whole number of 0 or more, got ${max}`);
        }
        this.file = file;
        this.max = max;
        this.lockWaitMs = lockWaitMs;
        this.load();
    }

    load() {
        this.data = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : { salt: crypto.randomBytes(16).toString('hex'), people: {} };
        this.data.held ??= {};
    }

    digest(userId) {
        return crypto.createHash('sha256').update(`${this.data.salt}:${userId}`).digest('hex').slice(0, 24);
    }

    get count() {
        return Object.keys(this.data.people).length;
    }

    /** Places held by reservations, except `hold`'s own. */
    reserved(hold = null) {
        return Object.entries(this.data.held).reduce((sum, [token, r]) => sum + (token === hold ? 0 : r.n), 0);
    }

    /** True when `n` more new people fit under the cap, by the file as it is now. */
    room(n = 1) {
        this.load();
        return this.count + this.reserved() + n <= this.max;
    }

    /** Holds `n` places for one game; returns the reservation, or null when they do not fit. */
    reserve(n) {
        return this.locked(() => {
            if (this.count + this.reserved() + n > this.max) {
                return null;
            }
            const hold = crypto.randomBytes(8).toString('hex');
            this.data.held[hold] = { n, at: new Date().toISOString() };
            this.save();
            return hold;
        });
    }

    /**
     * Counts what is left of a reservation as people who were contacted but not identified (a game joined before
     * its players were known), so they stay counted. Nothing happens once add() used it.
     */
    spend(hold, what) {
        if (!hold) {
            return;
        }
        this.locked(() => {
            const r = this.data.held[hold];
            if (r) {
                const at = new Date().toISOString();
                for (let i = 0; i < r.n; i++) {
                    this.data.people[`unidentified-${hold}-${i}`] = { at, what: `${what}, not identified` };
                }
                delete this.data.held[hold];
                this.save();
            }
        });
    }

    /** Gives back what is left of a reservation (none once add() used it). */
    release(hold) {
        if (!hold) {
            return;
        }
        this.locked(() => {
            if (Object.hasOwn(this.data.held, hold)) {
                delete this.data.held[hold];
                this.save();
            }
        });
    }

    has(userId) {
        return Object.hasOwn(this.data.people, this.digest(userId));
    }

    /**
     * Counts `userIds` (what: 'played' or 'watched') in place of reservation `hold`, which ends; returns how many were
     * new. Throws past the cap, without counting anyone.
     */
    add(userIds, what, hold = null) {
        return this.locked(() => {
            const fresh = [...new Set(userIds)].filter((id) => !this.has(id));
            const others = this.reserved(hold);
            if (this.count + others + fresh.length > this.max) {
                throw new Error(`people cap reached: ${this.count} of ${this.max} counted and ${others} reserved, ${fresh.length} more would pass it`);
            }
            const at = new Date().toISOString();
            for (const id of fresh) {
                this.data.people[this.digest(id)] = { at, what };
            }
            if (hold) {
                delete this.data.held[hold];
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
