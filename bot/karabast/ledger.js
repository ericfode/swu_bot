'use strict';
/**
 * How many real people our Karabast runs have touched, with a hard cap. Eric's limit for the pilot (2026-10-11): no
 * more than 10 real users. Every opponent of a bot game and both players of a watched game count, once each, from
 * the moment we are matched with them or join their game.
 *
 * The file keeps no ids or names: only salted SHA-256 digests (the salt is made once and kept in the file), so it can
 * say "already counted" without saying who. It is written with a temporary file and a rename after each change.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class PeopleLedger {
    constructor(file, max = 10) {
        this.file = file;
        this.max = max;
        this.data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { salt: crypto.randomBytes(16).toString('hex'), people: {} };
    }

    digest(userId) {
        return crypto.createHash('sha256').update(`${this.data.salt}:${userId}`).digest('hex').slice(0, 24);
    }

    get count() {
        return Object.keys(this.data.people).length;
    }

    /** True when `n` more new people fit under the cap. */
    room(n = 1) {
        return this.count + n <= this.max;
    }

    has(userId) {
        return Object.hasOwn(this.data.people, this.digest(userId));
    }

    /** Counts `userIds` (what: 'played' or 'watched'); returns how many were new. Throws past the cap. */
    add(userIds, what) {
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
    }

    save() {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        const tmp = `${this.file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(this.data, null, 1));
        fs.renameSync(tmp, this.file);
    }
}

module.exports = { PeopleLedger };
