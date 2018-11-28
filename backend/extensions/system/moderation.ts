import Bluebird from 'bluebird';
import { get, flatten } from 'lodash';

import events from '../../src/events';
import redis from '../../src/servers/redis';
import { client } from '../../src/client';
import { IListEntry } from '../../src/models/listEntry';
import { BlacklistEntryModel } from '../../src/models/blacklistEntry';
import { getSetting } from '../../src/settings';

/*
    Example message:

    "#n3rdstreettv", //channel
    { badges: { broadcaster: '1', subscriber: '0', premium: '1' }, // userstate
    color: '#B39619',
    'display-name': 'N3rdStreetTV',
    emotes: { '25': [ '0-4' ], '88': [ '19-26' ] },
    flags: null,
    id: '9591782e-5722-456d-b2b2-4ead30babcfc',
    mod: false,
    'room-id': '143989508',
    subscriber: true,
    'tmi-sent-ts': '1543070014569',
    turbo: false,
    'user-id': '143989508',
    'user-type': null,
    'emotes-raw': '25:0-4/88:19-26',
    'badges-raw': 'broadcaster/1,subscriber/0,premium/1',
    username: 'n3rdstreettv',
    'message-type': 'chat' },
    "Kappa Some Message PogChamp" // message
    -012345678901234567890123456
*/

// TODO: Make this configurable
export const MAX_EMOTE_COUNT = 15;
export const MAX_LENGTH = 300;
export const MAX_URL_COUNT = 0;
export const MAX_BLACKLISTED_WORDS_COUNT = 0;
export const MAX_WARNING_THRESHOLD = 3;
export const MAX_WARNING_TIMEOUT = 10 * 60;

// From: https://gist.github.com/dperini/729294
export const URL_REGEX = /(?:(?:(?:https?|ftp):)?\/\/)(?:\S+(?::\S*)?@)?(?:(?!(?:10|127)(?:\.\d{1,3}){3})(?!(?:169\.254|192\.168)(?:\.\d{1,3}){2})(?!172\.(?:1[6-9]|2\d|3[0-1])(?:\.\d{1,3}){2})(?:[1-9]\d?|1\d\d|2[01]\d|22[0-3])(?:\.(?:1?\d{1,2}|2[0-4]\d|25[0-5])){2}(?:\.(?:[1-9]\d?|1\d\d|2[0-4]\d|25[0-4]))|(?:(?:[a-z0-9\u00a1-\uffff][a-z0-9\u00a1-\uffff_-]{0,62})?[a-z0-9\u00a1-\uffff]\.)+(?:[a-z\u00a1-\uffff]{2,}\.?))(?::\d{2,5})?(?:[/?#]\S*)?/ig;

export const countEmotes = (_, userstate) => {
    return (userstate['emotes-raw'] && userstate['emotes-raw'].match(/\-/g) || []).length;
};

export const countLength = (msg, _) => {
    return msg.trim().length;
};

export const countUrls = (msg, _) => {
    return get(msg.match(URL_REGEX), 'length', 0);
}

export const countBlacklistedWords = (msg, _, blacklistedWords: Array<IListEntry> = []) => {
    const matches = blacklistedWords.map(e => {
        return msg.match(e.entryText);
    }).filter(e => !!e);

    return flatten(matches).length;
}

const getBlacklistedEntries = async () => {
    const finder = BlacklistEntryModel.find({
            active: true,
        }) as any;

    return finder
        .cache(15 * 60);
};

export const allowMessage = async (message, userstate, options?) => {
    if (!message || !message.trim) {
        return true;
    }

    message = message.trim();

    return (
        countEmotes(message, userstate) <= await getSetting('moderation.maxEmoteCount', MAX_EMOTE_COUNT) &&
        countLength(message, userstate) <= await getSetting('moderation.maxMessageLength', MAX_LENGTH) &&
        countUrls(message, userstate) <= await getSetting('moderation.maxUrlCount', MAX_URL_COUNT) &&
        countBlacklistedWords(message, userstate, ((options && options.blacklistEntries) || [])) <= await getSetting('moderation.maxBlacklistedWordsCount', MAX_BLACKLISTED_WORDS_COUNT)
    );
};

const getCurrentWarningThreshold = async (userId) => {
    // Commence anti-pattern...
    const $d = Bluebird.defer<number>();

    const redisKeyName = `warning_threshold:${userId}`;

    redis
        .multi()
        .incr(redisKeyName)
        .expire(redisKeyName, MAX_WARNING_TIMEOUT)
        .exec((err, _) => {
            if (err) {
                return $d.reject(err);
            }

            redis.getAsync(redisKeyName).then(res => {
                return $d.resolve(parseInt(res));
            });
        });

    return $d.promise;
};

const incomingMessage = async (details, _) => {
    // details -> { channel, userstate, message }

    // We can't timeout/delete broadcaster or mods, so don't bother
    if (get(details, 'userstate.mod', false) === true || get(details, 'userstate.badges.broadcaster', 0) === 1) {
        return;
    }

    const blacklistEntries = await getBlacklistedEntries();
    const allow = await allowMessage(details.message, details.userstate, {
        blacklistEntries,
    });

    if (!allow) {
        const warningThreshold = await getCurrentWarningThreshold(details.userstate['user-id']);
        const maxNum = await getSetting('moderation.maxWarningThreshold', MAX_WARNING_THRESHOLD);

        console.log('warningThreshold', warningThreshold, 'maxNum', maxNum);

        if (warningThreshold >= maxNum) {
            // Unfortunately, most clients still don't support this.  Give it a few
            // months for the major ones to catch up.  Chatty is in beta, there are
            // others.
            // The in meantime, 1 second timeout clears all chat history
            // client.deleteMessage(details.channel, details.userstate['id']);
            client.timeout(details.channel, details.userstate['username'], 1, 'Triggered moderation -- clearing chat');
        } else {
            // Write a strongly worded message...
            client.say(details.channel, `@${details.userstate['username']}: You triggered a moderation rule. This is warning ${warningThreshold} of ${maxNum}.`);
        }
    }
};

events.addListener('chat', 'message', incomingMessage);

export default {};
