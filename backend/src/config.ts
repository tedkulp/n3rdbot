import _ from 'lodash';
import { v4 } from 'uuid';

const STATE_TOKEN = v4();

class Config {

    private _data = {};
    private _loaded = false;
    private _stateToken = STATE_TOKEN;
    private _streamerScopes = [
        'chat:edit',
        'chat:read',
        'whispers:read',
        'whispers:edit',
        'channel_subscriptions',
        'channel_check_subscription',
    ];

    private _botScopes = [
        'channel:moderate',
        'chat:edit',
        'chat:read',
        'whispers:read',
        'whispers:edit',
        'channel_editor',
        'channel_commercial',
        'clips:edit',
        'user:edit:broadcast',
        'user:read:broadcast',
    ];

    private loadData() {
        if (!this._loaded)  {
            try {
                this._data = require('../config/config.json');
            } catch(e) {
                // TODO: Make this do something
            } finally {
                this._loaded = true;
            }
        }
    }

    private getValue(configKeyName: string, envName?: string) {
        if (envName && process.env[envName]) {
            return process.env[envName];
        } else {
            this.loadData();
            return _.get(this._data, configKeyName);
        }
    }

    public toJSON() {
        return {
            streamer: {
                username: this.getStreamerName(),
                password: this.getStreamerPassword(),
            },
            bot: {
                username: this.getBotName(),
                password: this.getBotPassword(),
            },
            redis: {
                host: this.getRedisHost(),
                port: this.getRedisPort(),
            },
            mongo: {
                url: this.getMongoUri(),
                dbName: this.getMongoDbName(),
            },
            options: {
                panelUser: this.getPanelUser(),
                panelPass: this.getPanelPass(),
                hostname: this.getHostname(),
                clientId: this.getClientId(),
                clientSecret: this.getClientSecret(),
                logLevel: this.getLogLevel(),
            },
            scopes: {
                streamer: this.getStreamerScopes(),
                bot: this.getBotScopes(),
            },
            stateToken: this.getStateToken(),
        };
    }

    public getStreamerName(): string {
        return this.getValue('streamer.username', 'STREAMER_USERNAME');
    }

    public getStreamerPassword(): string {
        return this.getValue('streamer.password', 'STREAMER_PASSWORD');
    }

    public getBotName(): string {
        return this.getValue('bot.username', 'BOT_USERNAME');
    }

    public getBotPassword(): string {
        return this.getValue('bot.password', 'BOT_PASSWORD');
    }

    public getRedisHost(): string {
        return this.getValue('redis.host', 'REDIS_HOST') || 'localhost';
    }

    public getRedisPort(): number {
        return parseInt(this.getValue('redis.port', 'REDIS_PORT')) || 6379;
    }

    public getMongoUri(): string {
        return this.getValue('mongo.url', 'MONGO_URL') || 'mongodb://localhost:27017';
    }

    public getMongoDbName(): string {
        return this.getValue('mongo.dbName', 'MONGO_DBNAME') || 'jidouka';
    }

    public getHostname(): string {
        return this.getValue('options.hostname', 'BOT_HOSTNAME');
    }

    public getClientId(): string {
        return this.getValue('options.clientId', 'OAUTH_CLIENT_ID');
    }

    public getClientSecret(): string {
        return this.getValue('options.clientSecret', 'OAUTH_CLIENT_SECRET');
    }

    public getLogLevel(): string {
        return this.getValue('options.logLevel', 'LOG_LEVEL') || 'info';
    }

    public getStateToken(): string {
        return this._stateToken;
    }

    public getPanelUser(): string {
        return this.getValue('options.panelUser', 'PANEL_USER');
    }

    public getPanelPass(): string {
        return this.getValue('options.panelPass', 'PANEL_PASS');
    }

    public getStreamerScopes(): string[] {
        return this._streamerScopes;
    }

    public getBotScopes(): string[] {
        return this._botScopes;
    }
}

export default new Config();
