import { hash, Map, Set } from 'immutable';
import _ from 'lodash';
import moment from 'moment';
import { setTimeout } from 'timers';
import Bluebird from 'bluebird';

import api from './api';
import config from './config';
import events from './events';
import logger from './logger';
import { UserModel } from './models/user';
import state from './state';

let watchers: Map<string, Set<Watcher>> = Map();
let timeouts: Map<symbol, NodeJS.Timeout> = Map();

const WATCH_TIMEOUT_TIME = 60 * 1000;
const WATCH_TIMEOUT_KEY = Symbol('watchTime');

const debugOutput = channel => {
    logger.silly('watchers', watchers.get(channel).map(w => `${w.username}(${w.mod})`));
};

const setTimeouts = () => {
    timeouts = timeouts.set(WATCH_TIMEOUT_KEY, setTimeout(updateWatchedTime, WATCH_TIMEOUT_TIME));
};

export class Watcher {
    public id?: number;
    public username: string;
    public startTime: moment.Moment;
    public lastReconciliationTime: moment.Moment;
    public mod: boolean;

    constructor(username: string, id?: number, isMod: boolean = false) {
        this.username = username;
        this.mod = isMod;
        this.startTime = moment();
        this.resetReconciliationTime();

        if (id) {
            this.id = id;
        }
    }

    public resetReconciliationTime() {
        this.lastReconciliationTime = moment();
        return this;
    }

    public equals(v: Watcher): boolean {
        return this.username === v.username;
    }

    public hashCode(): number {
        return hash(this.username);
    }
}

export const addWatcher = async (channel: string, username: string, isMod: boolean = false) => {
    // console.log('addWatcher', channel, username, isMod);

    if (!watchers.has(channel)) {
        watchers = watchers.set(channel, Set());
    }

    const user = watchers.get(channel).find(u => u.username === username);
    if (user) {
        return;
    }

    // Add the user immediately, then do the userid lookup
    // Because this can get called for the same user a lot of times
    // fairly quickly
    const watcher = new Watcher(username, null, isMod);
    watchers = watchers.set(channel, watchers.get(channel).add(watcher));

    watcher.id = await api.getUserId(username);

    debugOutput(channel);
};

export const removeWatcher = (channel: string, username: string): void => {
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

    debugOutput(channel);
};

export const getWatchers = (channel: string): Watcher[] => {
    if (!watchers.has(channel)) {
        watchers = watchers.set(channel, Set());
    }

    return watchers.get(channel).toArray();
};

export const addMod = async (channel: string, username: string) => {
    // console.log('addMod', channel, username);
    if (!watchers.has(channel)) {
        watchers = watchers.set(channel, Set());
    }

    const user = watchers.get(channel).find(u => u.username === username);
    if (user) {
        user.mod = true;
    } else {
        await addWatcher(channel, username, true);
    }

    debugOutput(channel);
};

export const removeMod = (channel: string, username: string): void => {
    if (!watchers.has(channel)) {
        watchers = watchers.set(channel, Set());
    }

    const user = watchers.get(channel).find(u => u.username === username);
    if (user) {
        user.mod = false;
    }

    debugOutput(channel);
};

export const getMods = (channel: string): Watcher[] => {
    if (!watchers.has(channel)) {
        watchers = watchers.set(channel, Set());
    }

    return watchers
        .get(channel)
        .filter(u => u.mod)
        .toArray();
};

const writeUptimes = async () => {
    return Bluebird.map(watchers.toIndexedSeq().toArray(), channel => {
        return Bluebird.map(channel.toArray(), watcher => {
            logger.silly('updating time', watcher.username);
            const timeToUpdate = moment().diff(watcher.lastReconciliationTime);
            watcher.resetReconciliationTime();

            return UserModel.updateOne(
                {
                    username: watcher.username,
                },
                {
                    $inc: {
                        watchedTime: Math.round(timeToUpdate / 1000),
                    },
                }
            ).exec();
        });
    });
};

export const updateWatchedTime = async () => {
    logger.silly('updateWatchedTime');

    if (state.isOnline()) {
        logger.silly("We're online");
        await writeUptimes();
    } else {
        logger.silly("We're not updating the times for people");
    }

    setTimeouts();
};

const updateMessageCount = userstate => {
    logger.silly('updateMessageCount');

    UserModel.updateOne(
        {
            username: userstate.username,
        },
        {
            $inc: {
                numMessages: 1,
            },
        }
    ).exec();
};

const resetReconciliationTime = channel => {
    const found = watchers.find((_v, k) => k === channel);
    if (found) {
        found.forEach(u => u.resetReconciliationTime());
    }
};

export const init = (initTimouts = true) => {
    if (initTimouts) {
        setTimeouts();
    }

    events.addListener('webhook', 'offline', data => {
        logger.debug('webhook.offline', data);

        // TODO: Do we need multiple channels?

        // Dump all the current times out to the database
        // and make sure don't track anymore
        // updateWatchedTime(false, false);
        writeUptimes().then(() => {
            return resetReconciliationTime(config.getStreamerName());
        });
    });

    events.addListener('webhook', 'online', data => {
        logger.debug('webhook.online', data);

        resetReconciliationTime(config.getStreamerName());
    });

    events.addListener('chat', 'message', (details: object, _msg) => {
        updateMessageCount(details['userstate']);
    });

    // channel, username, self
    events.addListener('chat', 'join', (details: object, _msg) => {
        return addWatcher(details['channel'], details['username']);
    });

    // channel, username, self
    events.addListener('chat', 'part', (details: object, _msg) => {
        return removeWatcher(details['channel'], details['username']);
    });

    // channel, usernames (as array)
    events.addListener('chat', 'names', (details: object, _msg) => {
        _.each(details['usernames'], username => {
            return addWatcher(details['channel'], username);
        });
    });

    // channel, usernames (as array)
    events.addListener('chat', 'mods', (details: object, _msg) => {
        _.each(details['usernames'], username => {
            return addMod(details['channel'], username);
        });
    });

    // channel, username
    events.addListener('chat', 'mod', (details: object, _msg) => {
        return addMod(details['channel'], details['username']);
    });

    // channel, username
    events.addListener('chat', 'unmod', (details: object, _msg) => {
        return removeMod(details['channel'], details['username']);
    });
};

export const clear = () => {
    watchers = Map();
};

export default {
    addWatcher,
    removeWatcher,
    getWatchers,
    addMod,
    removeMod,
    getMods,
    init,
    clear,
    updateWatchedTime,
};
