import { Set, Map, hash } from 'immutable';
import moment from 'moment';
import _ from 'lodash';

import config from '../config/config.json';
import api from './api';
import state from './state';
import logger from './logger';
import { setTimeout } from 'timers';
import { getDb } from './servers/mongo';
import events from './events';

let watchers: Map<string, Set<Watcher>> = Map();
let timeouts: Map<Symbol, NodeJS.Timeout> = Map();

const WATCH_TIMEOUT_TIME = 60 * 1000;
const WATCH_TIMEOUT_KEY = Symbol('watchTime');

export class Watcher {
    id?: number;
    username: string;
    startTime: moment.Moment;
    lastReconciliationTime: moment.Moment;
    mod: boolean;

    constructor(username: string, id?: number, isMod: boolean = false) {
        this.username = username;
        this.mod = isMod;
        this.startTime = moment();
        this.lastReconciliationTime = moment();

        if (id) {
            this.id = id;
        }
    }

    equals(v: Watcher): boolean {
        return this.username === v.username;
    }

    hashCode(): number {
        return hash(this.username);
    }
}

const addWatcher = async (channel: string, username: string, isMod: boolean = false) => {
    if (!watchers.has(channel)) {
        watchers = watchers.set(channel, Set());
    }

    const user = watchers.get(channel).find(u => u.username === username);
    if (user) {
        return;
    }

    const userId = await api.getUserId(username);
    watchers = watchers.set(channel, watchers.get(channel).add(new Watcher(username, userId, isMod)));

    logger.debug(watchers.get(channel).toJSON());
};

const removeWatcher = (channel: string, username: string): void => {
    if (!watchers.has(channel)) {
        watchers = watchers.set(channel, Set());
        return;
    }

    const user = watchers.get(channel).find(u => u.username === username);
    if (user) {
        // TODO: Make sure to update time in database if they
        // left
        watchers = watchers.set(channel, watchers.get(channel).remove(user));
    }

    logger.debug(watchers.get(channel).toJSON());
};

const getWatchers = (channel: string): Array<Watcher> => {
    if (!watchers.has(channel)) {
        watchers = watchers.set(channel, Set());
    }

    return watchers.get(channel).toArray();
};

const addMod = async (channel: string, username: string) => {
    if (!watchers.has(channel)) {
        watchers = watchers.set(channel, Set());
        return;
    }

    const user = watchers.get(channel).find(u => u.username === username);
    if (user) {
        user.mod = true;
    } else {
        addWatcher(channel, username, true);
    }

    logger.debug(watchers.get(channel).toJSON());
};

const removeMod = (channel: string, username: string): void => {
    if (!watchers.has(channel)) {
        watchers = watchers.set(channel, Set());
        return;
    }

    const user = watchers.get(channel).find(u => u.username === username);
    if (user) {
        user.mod = false;
    }

    logger.debug(watchers.get(channel).toJSON());
};

const getMods = (channel: string): Array<Watcher> => {
    if (!watchers.has(channel)) {
        watchers = watchers.set(channel, Set());
    }

    return watchers.get(channel).filter(u => u.mod).toArray();
};

const updateWatchedTime = async (noOnlineCheck: boolean = false, resetTimeout: boolean = true) => {
    logger.debug('updateWatchedTime');
    const db = await getDb();
    const coll = db.collection('users');

    if (state.isOnline() || noOnlineCheck) {
        watchers.forEach(channel => {
            channel.forEach(watcher => {
                const timeToUpdate = moment().diff(watcher.lastReconciliationTime);
                watcher.lastReconciliationTime = moment();

                coll.updateOne({
                    username: watcher.username,
                }, {
                    $inc: {
                        watchedTime: Math.round(timeToUpdate / 1000),
                    },
                });
            });
        });
    }

    if (resetTimeout) {
        timeouts = timeouts.set(WATCH_TIMEOUT_KEY, setTimeout(updateWatchedTime, WATCH_TIMEOUT_TIME));
    }
};

timeouts = timeouts.set(WATCH_TIMEOUT_KEY, setTimeout(updateWatchedTime, WATCH_TIMEOUT_TIME));

const resetReconciliationTime = channel => {
    const found = watchers.find((_, k) => k === channel);
    if (found) {
        found.forEach(u => u.lastReconciliationTime = moment());
    }
};

events.addListener('webhook', 'offline', data => {
    logger.info(['webhook.offline', data]);

    // TODO: Do we need multiple channels?

    // Dump all the current times out to the database
    // and make sure don't track anymore
    updateWatchedTime(true, false);
    resetReconciliationTime(config.streamer.username);
});

events.addListener('webhook', 'online', data => {
    logger.info(['webhook.online', data]);

    resetReconciliationTime(config.streamer.username);
});

export default {
    addWatcher,
    removeWatcher,
    getWatchers,
    addMod,
    removeMod,
    getMods,
};