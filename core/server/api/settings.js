// # Settings API
// RESTful API for the Setting resource
var _            = require('lodash'),
    dataProvider = require('../models'),
    Promise      = require('bluebird'),
    config       = require('../config'),
    canThis      = require('../permissions').canThis,
    errors       = require('../errors'),
    utils        = require('./utils'),
    i18n         = require('../i18n'),
    filterPackages = require('../utils/packages').filterPackages,

    docName      = 'settings',
    settings,

    settingsCache = require('../settings/cache'),

    updateSettingsCache,
    settingsFilter,
    readSettingsResult,
    settingsResult,
    canEditAllSettings,

// @TODO simplify this!
updateSettingsCache = function updateSettingsCache(settings, options) {
    options = options || {};
    settings = settings || {};

    if (!_.isEmpty(settings)) {
        _.map(settings, function (setting, key) {
            settingsCache.set(key, setting);
        });

        return Promise.resolve(settingsCache.getAll());
    }

    return dataProvider.Settings.findAll(options)
        .then(function (result) {
            // keep reference and update all keys
            _.each(readSettingsResult(result.models), function (setting, key) {
                settingsCache.set(key, setting);
            });

            return settingsCache.getAll();
        });
};

// ## Helpers

/**
 * ### Settings Filter
 * Filters an object based on a given filter object
 * @private
 * @param {Object} settings
 * @param {String} filter
 * @returns {*}
 */
settingsFilter = function (settings, filter) {
    return _.fromPairs(_.filter(_.toPairs(settings), function (setting) {
        if (filter) {
            return _.some(filter.split(','), function (f) {
                return setting[1].type === f;
            });
        }
        return true;
    }));
};

/**
 * ### Read Settings Result
 * @private
 * @param {Array} settingsModels
 * @returns {Settings}
 */
readSettingsResult = function (settingsModels) {
    var settings = _.reduce(settingsModels, function (memo, member) {
            if (!memo.hasOwnProperty(member.attributes.key)) {
                memo[member.attributes.key] = member.attributes;
            }

            return memo;
        }, {}),
        themes = config.get('paths').availableThemes,
        res;

    // @TODO: remove availableThemes from settings cache and create an endpoint to fetch themes
    if (settings.activeTheme && themes) {
        res = filterPackages(themes, settings.activeTheme.value);

        settings.availableThemes = {
            key: 'availableThemes',
            value: res,
            type: 'theme'
        };
    }

    return settings;
};

/**
 * ### Settings Result
 * @private
 * @param {Object} settings
 * @param {String} type
 * @returns {{settings: *}}
 */
settingsResult = function (settings, type) {
    var filteredSettings = _.values(settingsFilter(settings, type)),
        result = {
            settings: filteredSettings,
            meta: {}
        };

    if (type) {
        result.meta.filters = {
            type: type
        };
    }

    return result;
};

/**
 * ### Can Edit All Settings
 * Check that this edit request is allowed for all settings requested to be updated
 * @private
 * @param {Object} settingsInfo
 * @returns {*}
 */
canEditAllSettings = function (settingsInfo, options) {
    var checkSettingPermissions = function checkSettingPermissions(setting) {
            if (setting.type === 'core' && !(options.context && options.context.internal)) {
                return Promise.reject(
                    new errors.NoPermissionError({message: i18n.t('errors.api.settings.accessCoreSettingFromExtReq')})
                );
            }

            return canThis(options.context).edit.setting(setting.key).catch(function () {
                return Promise.reject(new errors.NoPermissionError({message: i18n.t('errors.api.settings.noPermissionToEditSettings')}));
            });
        },
        checks = _.map(settingsInfo, function (settingInfo) {
            var setting = settingsCache.get(settingInfo.key, {resolve: false});

            if (!setting) {
                return Promise.reject(new errors.NotFoundError(
                    {message: i18n.t('errors.api.settings.problemFindingSetting', {key: settingInfo.key})}
                ));
            }

            return checkSettingPermissions(setting);
        });

    return Promise.all(checks);
};

/**
 * ## Settings API Methods
 *
 * **See:** [API Methods](index.js.html#api%20methods)
 */
settings = {

    /**
     * ### Browse
     * @param {Object} options
     * @returns {*}
     */
    browse: function browse(options) {
        options = options || {};

        var result = settingsResult(settingsCache.getAll(), options.type);

        // If there is no context, return only blog settings
        if (!options.context) {
            return Promise.resolve(_.filter(result.settings, function (setting) { return setting.type === 'blog'; }));
        }

        // Otherwise return whatever this context is allowed to browse
        return canThis(options.context).browse.setting().then(function () {
            // Omit core settings unless internal request
            if (!options.context.internal) {
                result.settings = _.filter(result.settings, function (setting) { return setting.type !== 'core'; });
            }

            return result;
        });
    },

    /**
     * ### Read
     * @param {Object} options
     * @returns {*}
     */
    read: function read(options) {
        if (_.isString(options)) {
            options = {key: options};
        }

        var setting = settingsCache.get(options.key, {resolve: false}),
            result = {};

        if (!setting) {
            return Promise.reject(new errors.NotFoundError(
                {message: i18n.t('errors.api.settings.problemFindingSetting', {key: options.key})}
            ));
        }

        result[options.key] = setting;

        if (setting.type === 'core' && !(options.context && options.context.internal)) {
            return Promise.reject(
                new errors.NoPermissionError({message: i18n.t('errors.api.settings.accessCoreSettingFromExtReq')})
            );
        }

        if (setting.type === 'blog') {
            return Promise.resolve(settingsResult(result));
        }

        return canThis(options.context).read.setting(options.key).then(function () {
            return settingsResult(result);
        }, function () {
            return Promise.reject(new errors.NoPermissionError({message: i18n.t('errors.api.settings.noPermissionToReadSettings')}));
        });
    },

    /**
     * ### Edit
     * Update properties of a setting
     * @param {{settings: }} object Setting or a single string name
     * @param {{id (required), include,...}} options (optional) or a single string value
     * @return {Promise(Setting)} Edited Setting
     */
    edit: function edit(object, options) {
        options = options || {};
        var self = this,
            type;

        // Allow shorthand syntax where a single key and value are passed to edit instead of object and options
        if (_.isString(object)) {
            object = {settings: [{key: object, value: options}]};
        }

        // clean data
        _.each(object.settings, function (setting) {
            if (!_.isString(setting.value)) {
                setting.value = JSON.stringify(setting.value);
            }
        });

        type = _.find(object.settings, function (setting) { return setting.key === 'type'; });
        if (_.isObject(type)) {
            type = type.value;
        }

        object.settings = _.reject(object.settings, function (setting) {
            return setting.key === 'type' || setting.key === 'availableThemes';
        });

        return canEditAllSettings(object.settings, options).then(function () {
            return utils.checkObject(object, docName).then(function (checkedData) {
                options.user = self.user;
                return dataProvider.Settings.edit(checkedData.settings, options);
            }).then(function (result) {
                var readResult = readSettingsResult(result);

                return updateSettingsCache(readResult).then(function () {
                    return settingsResult(readResult, type);
                });
            });
        });
    }
};

module.exports = settings;

module.exports.updateSettingsCache = updateSettingsCache;
