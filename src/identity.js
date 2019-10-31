import Helpers from './helpers';
import Constants from './constants';
import ServerModel from './serverModel';
import Forwarders from './forwarders';
import Persistence from './persistence';
import Types from './types';
import NativeSdkHelpers from './nativeSdkHelpers';
import ApiClient from './apiClient';
import CookieSyncManager from './cookieSyncManager';
import Events from './events';

var Messages = Constants.Messages,
    Validators = Helpers.Validators,
    HTTPCodes = Constants.HTTPCodes,
    sendIdentityRequest = ApiClient.sendIdentityRequest,
    sendEventToServer = ApiClient.sendEventToServer;

function checkIdentitySwap(previousMPID, currentMPID, currentSessionMPIDs) {
    if (previousMPID && currentMPID && previousMPID !== currentMPID) {
        var cookies = Persistence.useLocalStorage()
            ? Persistence.getLocalStorage()
            : Persistence.getCookie();
        cookies.cu = currentMPID;
        cookies.gs.csm = currentSessionMPIDs;
        Persistence.saveCookies(cookies);
    }
}

var IdentityRequest = {
    createKnownIdentities: function(identityApiData, deviceId) {
        var identitiesResult = {};

        if (
            identityApiData &&
            identityApiData.userIdentities &&
            Helpers.isObject(identityApiData.userIdentities)
        ) {
            for (var identity in identityApiData.userIdentities) {
                identitiesResult[identity] =
                    identityApiData.userIdentities[identity];
            }
        }
        identitiesResult.device_application_stamp = deviceId;

        return identitiesResult;
    },

    preProcessIdentityRequest: function(identityApiData, callback, method) {
        mParticle.Logger.verbose(
            Messages.InformationMessages.StartingLogEvent + ': ' + method
        );

        var identityValidationResult = Validators.validateIdentities(
            identityApiData,
            method
        );

        if (!identityValidationResult.valid) {
            mParticle.Logger.error('ERROR: ' + identityValidationResult.error);
            return {
                valid: false,
                error: identityValidationResult.error,
            };
        }

        if (callback && !Validators.isFunction(callback)) {
            var error =
                'The optional callback must be a function. You tried entering a(n) ' +
                typeof callback;
            mParticle.Logger.error(error);
            return {
                valid: false,
                error: error,
            };
        }

        return {
            valid: true,
        };
    },

    createIdentityRequest: function(
        identityApiData,
        platform,
        sdkVendor,
        sdkVersion,
        deviceId,
        context,
        mpid
    ) {
        var APIRequest = {
            client_sdk: {
                platform: platform,
                sdk_vendor: sdkVendor,
                sdk_version: sdkVersion,
            },
            context: context,
            environment: mParticle.Store.SDKConfig.isDevelopmentMode
                ? 'development'
                : 'production',
            request_id: Helpers.generateUniqueId(),
            request_timestamp_ms: new Date().getTime(),
            previous_mpid: mpid || null,
            known_identities: this.createKnownIdentities(
                identityApiData,
                deviceId
            ),
        };

        return APIRequest;
    },

    createModifyIdentityRequest: function(
        currentUserIdentities,
        newUserIdentities,
        platform,
        sdkVendor,
        sdkVersion,
        context
    ) {
        return {
            client_sdk: {
                platform: platform,
                sdk_vendor: sdkVendor,
                sdk_version: sdkVersion,
            },
            context: context,
            environment: mParticle.Store.SDKConfig.isDevelopmentMode
                ? 'development'
                : 'production',
            request_id: Helpers.generateUniqueId(),
            request_timestamp_ms: new Date().getTime(),
            identity_changes: this.createIdentityChanges(
                currentUserIdentities,
                newUserIdentities
            ),
        };
    },

    createIdentityChanges: function(previousIdentities, newIdentities) {
        var identityChanges = [];
        var key;
        if (
            newIdentities &&
            Helpers.isObject(newIdentities) &&
            previousIdentities &&
            Helpers.isObject(previousIdentities)
        ) {
            for (key in newIdentities) {
                identityChanges.push({
                    old_value: previousIdentities[key] || null,
                    new_value: newIdentities[key],
                    identity_type: key,
                });
            }
        }

        return identityChanges;
    },

    modifyUserIdentities: function(previousUserIdentities, newUserIdentities) {
        var modifiedUserIdentities = {};

        for (var key in newUserIdentities) {
            modifiedUserIdentities[Types.IdentityType.getIdentityType(key)] =
                newUserIdentities[key];
        }

        for (key in previousUserIdentities) {
            if (!modifiedUserIdentities[key]) {
                modifiedUserIdentities[key] = previousUserIdentities[key];
            }
        }

        return modifiedUserIdentities;
    },

    createAliasNetworkRequest: function(aliasRequest) {
        return {
            request_id: Helpers.generateUniqueId(),
            request_type: 'alias',
            environment: mParticle.Store.SDKConfig.isDevelopmentMode
                ? 'development'
                : 'production',
            api_key: mParticle.Store.devToken,
            data: {
                destination_mpid: aliasRequest.destinationMpid,
                source_mpid: aliasRequest.sourceMpid,
                start_unixtime_ms: aliasRequest.startTime,
                end_unixtime_ms: aliasRequest.endTime,
                device_application_stamp: mParticle.Store.deviceId,
            },
        };
    },

    convertAliasToNative: function(aliasRequest) {
        return {
            DestinationMpid: aliasRequest.destinationMpid,
            SourceMpid: aliasRequest.sourceMpid,
            StartUnixtimeMs: aliasRequest.startTime,
            EndUnixtimeMs: aliasRequest.endTime,
        };
    },

    convertToNative: function(identityApiData) {
        var nativeIdentityRequest = [];
        if (identityApiData && identityApiData.userIdentities) {
            for (var key in identityApiData.userIdentities) {
                if (identityApiData.userIdentities.hasOwnProperty(key)) {
                    nativeIdentityRequest.push({
                        Type: Types.IdentityType.getIdentityType(key),
                        Identity: identityApiData.userIdentities[key],
                    });
                }
            }

            return {
                UserIdentities: nativeIdentityRequest,
            };
        }
    },
};
/**
 * Invoke these methods on the mParticle.Identity object.
 * Example: mParticle.Identity.getCurrentUser().
 * @class mParticle.Identity
 */
var IdentityAPI = {
    HTTPCodes: HTTPCodes,
    /**
     * Initiate a logout request to the mParticle server
     * @method identify
     * @param {Object} identityApiData The identityApiData object as indicated [here](https://github.com/mParticle/mparticle-sdk-javascript/blob/master-v2/README.md#1-customize-the-sdk)
     * @param {Function} [callback] A callback function that is called when the identify request completes
     */
    identify: function(identityApiData, callback) {
        var mpid,
            currentUser = mParticle.Identity.getCurrentUser(),
            preProcessResult = IdentityRequest.preProcessIdentityRequest(
                identityApiData,
                callback,
                'identify'
            );
        if (currentUser) {
            mpid = currentUser.getMPID();
        }

        if (preProcessResult.valid) {
            var identityApiRequest = IdentityRequest.createIdentityRequest(
                identityApiData,
                Constants.platform,
                Constants.sdkVendor,
                Constants.sdkVersion,
                mParticle.Store.deviceId,
                mParticle.Store.context,
                mpid
            );

            if (Helpers.canLog()) {
                if (mParticle.Store.webviewBridgeEnabled) {
                    NativeSdkHelpers.sendToNative(
                        Constants.NativeSdkPaths.Identify,
                        JSON.stringify(
                            IdentityRequest.convertToNative(identityApiData)
                        )
                    );
                    Helpers.invokeCallback(
                        callback,
                        HTTPCodes.nativeIdentityRequest,
                        'Identify request sent to native sdk'
                    );
                } else {
                    sendIdentityRequest(
                        identityApiRequest,
                        'identify',
                        callback,
                        identityApiData,
                        parseIdentityResponse,
                        mpid
                    );
                }
            } else {
                Helpers.invokeCallback(
                    callback,
                    HTTPCodes.loggingDisabledOrMissingAPIKey,
                    Messages.InformationMessages.AbandonLogEvent
                );
                mParticle.Logger.verbose(
                    Messages.InformationMessages.AbandonLogEvent
                );
            }
        } else {
            Helpers.invokeCallback(
                callback,
                HTTPCodes.validationIssue,
                preProcessResult.error
            );
            mParticle.Logger.verbose(preProcessResult);
        }
    },
    /**
     * Initiate a logout request to the mParticle server
     * @method logout
     * @param {Object} identityApiData The identityApiData object as indicated [here](https://github.com/mParticle/mparticle-sdk-javascript/blob/master-v2/README.md#1-customize-the-sdk)
     * @param {Function} [callback] A callback function that is called when the logout request completes
     */
    logout: function(identityApiData, callback) {
        var mpid,
            currentUser = mParticle.Identity.getCurrentUser(),
            preProcessResult = IdentityRequest.preProcessIdentityRequest(
                identityApiData,
                callback,
                'logout'
            );
        if (currentUser) {
            mpid = currentUser.getMPID();
        }

        if (preProcessResult.valid) {
            var evt,
                identityApiRequest = IdentityRequest.createIdentityRequest(
                    identityApiData,
                    Constants.platform,
                    Constants.sdkVendor,
                    Constants.sdkVersion,
                    mParticle.Store.deviceId,
                    mParticle.Store.context,
                    mpid
                );

            if (Helpers.canLog()) {
                if (mParticle.Store.webviewBridgeEnabled) {
                    NativeSdkHelpers.sendToNative(
                        Constants.NativeSdkPaths.Logout,
                        JSON.stringify(
                            IdentityRequest.convertToNative(identityApiData)
                        )
                    );
                    Helpers.invokeCallback(
                        callback,
                        HTTPCodes.nativeIdentityRequest,
                        'Logout request sent to native sdk'
                    );
                } else {
                    sendIdentityRequest(
                        identityApiRequest,
                        'logout',
                        callback,
                        identityApiData,
                        parseIdentityResponse,
                        mpid
                    );
                    evt = ServerModel.createEventObject({
                        messageType: Types.MessageType.Profile,
                    });
                    evt.ProfileMessageType = Types.ProfileMessageType.Logout;
                    if (mParticle.Store.activeForwarders.length) {
                        mParticle.Store.activeForwarders.forEach(function(
                            forwarder
                        ) {
                            if (forwarder.logOut) {
                                forwarder.logOut(evt);
                            }
                        });
                    }
                }
            } else {
                Helpers.invokeCallback(
                    callback,
                    HTTPCodes.loggingDisabledOrMissingAPIKey,
                    Messages.InformationMessages.AbandonLogEvent
                );
                mParticle.Logger.verbose(
                    Messages.InformationMessages.AbandonLogEvent
                );
            }
        } else {
            Helpers.invokeCallback(
                callback,
                HTTPCodes.validationIssue,
                preProcessResult.error
            );
            mParticle.Logger.verbose(preProcessResult);
        }
    },
    /**
     * Initiate a login request to the mParticle server
     * @method login
     * @param {Object} identityApiData The identityApiData object as indicated [here](https://github.com/mParticle/mparticle-sdk-javascript/blob/master-v2/README.md#1-customize-the-sdk)
     * @param {Function} [callback] A callback function that is called when the login request completes
     */
    login: function(identityApiData, callback) {
        var mpid,
            currentUser = mParticle.Identity.getCurrentUser(),
            preProcessResult = IdentityRequest.preProcessIdentityRequest(
                identityApiData,
                callback,
                'login'
            );
        if (currentUser) {
            mpid = currentUser.getMPID();
        }

        if (preProcessResult.valid) {
            var identityApiRequest = IdentityRequest.createIdentityRequest(
                identityApiData,
                Constants.platform,
                Constants.sdkVendor,
                Constants.sdkVersion,
                mParticle.Store.deviceId,
                mParticle.Store.context,
                mpid
            );

            if (Helpers.canLog()) {
                if (mParticle.Store.webviewBridgeEnabled) {
                    NativeSdkHelpers.sendToNative(
                        Constants.NativeSdkPaths.Login,
                        JSON.stringify(
                            IdentityRequest.convertToNative(identityApiData)
                        )
                    );
                    Helpers.invokeCallback(
                        callback,
                        HTTPCodes.nativeIdentityRequest,
                        'Login request sent to native sdk'
                    );
                } else {
                    sendIdentityRequest(
                        identityApiRequest,
                        'login',
                        callback,
                        identityApiData,
                        parseIdentityResponse,
                        mpid
                    );
                }
            } else {
                Helpers.invokeCallback(
                    callback,
                    HTTPCodes.loggingDisabledOrMissingAPIKey,
                    Messages.InformationMessages.AbandonLogEvent
                );
                mParticle.Logger.verbose(
                    Messages.InformationMessages.AbandonLogEvent
                );
            }
        } else {
            Helpers.invokeCallback(
                callback,
                HTTPCodes.validationIssue,
                preProcessResult.error
            );
            mParticle.Logger.verbose(preProcessResult);
        }
    },
    /**
     * Initiate a modify request to the mParticle server
     * @method modify
     * @param {Object} identityApiData The identityApiData object as indicated [here](https://github.com/mParticle/mparticle-sdk-javascript/blob/master-v2/README.md#1-customize-the-sdk)
     * @param {Function} [callback] A callback function that is called when the modify request completes
     */
    modify: function(identityApiData, callback) {
        var mpid,
            currentUser = mParticle.Identity.getCurrentUser(),
            preProcessResult = IdentityRequest.preProcessIdentityRequest(
                identityApiData,
                callback,
                'modify'
            );
        if (currentUser) {
            mpid = currentUser.getMPID();
        }
        var newUserIdentities =
            identityApiData && identityApiData.userIdentities
                ? identityApiData.userIdentities
                : {};
        if (preProcessResult.valid) {
            var identityApiRequest = IdentityRequest.createModifyIdentityRequest(
                currentUser
                    ? currentUser.getUserIdentities().userIdentities
                    : {},
                newUserIdentities,
                Constants.platform,
                Constants.sdkVendor,
                Constants.sdkVersion,
                mParticle.Store.context
            );

            if (Helpers.canLog()) {
                if (mParticle.Store.webviewBridgeEnabled) {
                    NativeSdkHelpers.sendToNative(
                        Constants.NativeSdkPaths.Modify,
                        JSON.stringify(
                            IdentityRequest.convertToNative(identityApiData)
                        )
                    );
                    Helpers.invokeCallback(
                        callback,
                        HTTPCodes.nativeIdentityRequest,
                        'Modify request sent to native sdk'
                    );
                } else {
                    sendIdentityRequest(
                        identityApiRequest,
                        'modify',
                        callback,
                        identityApiData,
                        parseIdentityResponse,
                        mpid
                    );
                }
            } else {
                Helpers.invokeCallback(
                    callback,
                    HTTPCodes.loggingDisabledOrMissingAPIKey,
                    Messages.InformationMessages.AbandonLogEvent
                );
                mParticle.Logger.verbose(
                    Messages.InformationMessages.AbandonLogEvent
                );
            }
        } else {
            Helpers.invokeCallback(
                callback,
                HTTPCodes.validationIssue,
                preProcessResult.error
            );
            mParticle.Logger.verbose(preProcessResult);
        }
    },
    /**
     * Returns a user object with methods to interact with the current user
     * @method getCurrentUser
     * @return {Object} the current user object
     */
    getCurrentUser: function() {
        var mpid = mParticle.Store.mpid;
        if (mpid) {
            mpid = mParticle.Store.mpid.slice();
            return mParticleUser(mpid, mParticle.Store.isLoggedIn);
        } else if (mParticle.Store.webviewBridgeEnabled) {
            return mParticleUser();
        } else {
            return null;
        }
    },

    /**
     * Returns a the user object associated with the mpid parameter or 'null' if no such
     * user exists
     * @method getUser
     * @param {String} mpid of the desired user
     * @return {Object} the user for  mpid
     */
    getUser: function(mpid) {
        var cookies = Persistence.getPersistence();
        if (cookies) {
            if (
                cookies[mpid] &&
                !Constants.SDKv2NonMPIDCookieKeys.hasOwnProperty(mpid)
            ) {
                return mParticleUser(mpid);
            } else {
                return null;
            }
        } else {
            return null;
        }
    },

    /**
     * Returns all users, including the current user and all previous users that are stored on the device.
     * @method getUsers
     * @return {Array} array of users
     */
    getUsers: function() {
        var cookies = Persistence.getPersistence();
        var users = [];
        if (cookies) {
            for (var key in cookies) {
                if (!Constants.SDKv2NonMPIDCookieKeys.hasOwnProperty(key)) {
                    users.push(mParticleUser(key));
                }
            }
        }
        users.sort(function(a, b) {
            var aLastSeen = a.getLastSeenTime() || 0;
            var bLastSeen = b.getLastSeenTime() || 0;
            if (aLastSeen > bLastSeen) {
                return -1;
            } else {
                return 1;
            }
        });
        return users;
    },

    /**
     * Initiate an alias request to the mParticle server
     * @method aliasUsers
     * @param {Object} aliasRequest  object representing an AliasRequest
     * @param {Function} [callback] A callback function that is called when the aliasUsers request completes
     */
    aliasUsers: function(aliasRequest, callback) {
        var message;
        if (!aliasRequest.destinationMpid || !aliasRequest.sourceMpid) {
            message = Messages.ValidationMessages.AliasMissingMpid;
        }
        if (aliasRequest.destinationMpid === aliasRequest.sourceMpid) {
            message = Messages.ValidationMessages.AliasNonUniqueMpid;
        }
        if (!aliasRequest.startTime || !aliasRequest.endTime) {
            message = Messages.ValidationMessages.AliasMissingTime;
        }
        if (aliasRequest.startTime > aliasRequest.endTime) {
            message = Messages.ValidationMessages.AliasStartBeforeEndTime;
        }
        if (message) {
            mParticle.Logger.warning(message);
            Helpers.invokeAliasCallback(
                callback,
                HTTPCodes.validationIssue,
                message
            );
            return;
        }
        if (Helpers.canLog()) {
            if (mParticle.Store.webviewBridgeEnabled) {
                NativeSdkHelpers.sendToNative(
                    Constants.NativeSdkPaths.Alias,
                    JSON.stringify(
                        IdentityRequest.convertAliasToNative(aliasRequest)
                    )
                );
                Helpers.invokeAliasCallback(
                    callback,
                    HTTPCodes.nativeIdentityRequest,
                    'Alias request sent to native sdk'
                );
            } else {
                mParticle.Logger.verbose(
                    Messages.InformationMessages.StartingAliasRequest +
                        ': ' +
                        aliasRequest.sourceMpid +
                        ' -> ' +
                        aliasRequest.destinationMpid
                );
                var aliasRequestMessage = IdentityRequest.createAliasNetworkRequest(
                    aliasRequest
                );
                ApiClient.sendAliasRequest(aliasRequestMessage, callback);
            }
        } else {
            Helpers.invokeAliasCallback(
                callback,
                HTTPCodes.loggingDisabledOrMissingAPIKey,
                Messages.InformationMessages.AbandonAliasUsers
            );
            mParticle.Logger.verbose(
                Messages.InformationMessages.AbandonAliasUsers
            );
        }
    },

    /**
      Create a default AliasRequest for 2 MParticleUsers. This will construct the request
      using the sourceUser's firstSeenTime as the startTime, and its lastSeenTime as the endTime.
     
      In the unlikely scenario that the sourceUser does not have a firstSeenTime, which will only
      be the case if they have not been the current user since this functionality was added, the 
      startTime will be populated with the earliest firstSeenTime out of any stored user. Similarly,
      if the sourceUser does not have a lastSeenTime, the endTime will be populated with the current time
     
      There is a limit to how old the startTime can be, represented by the config field 'aliasMaxWindow', in days.
      If the startTime falls before the limit, it will be adjusted to the oldest allowed startTime. 
      In rare cases, where the sourceUser's lastSeenTime also falls outside of the aliasMaxWindow limit, 
      after applying this adjustment it will be impossible to create an aliasRequest passes the aliasUsers() 
      validation that the startTime must be less than the endTime 
     */
    createAliasRequest: function(sourceUser, destinationUser) {
        try {
            if (!destinationUser || !sourceUser) {
                mParticle.Logger.error(
                    "'destinationUser' and 'sourceUser' must both be present"
                );
                return null;
            }
            var startTime = sourceUser.getFirstSeenTime();
            if (!startTime) {
                mParticle.Identity.getUsers().forEach(function(user) {
                    if (
                        user.getFirstSeenTime() &&
                        (!startTime || user.getFirstSeenTime() < startTime)
                    ) {
                        startTime = user.getFirstSeenTime();
                    }
                });
            }
            var minFirstSeenTimeMs =
                new Date().getTime() -
                mParticle.Store.SDKConfig.aliasMaxWindow * 24 * 60 * 60 * 1000;
            var endTime = sourceUser.getLastSeenTime() || new Date().getTime();
            //if the startTime is greater than $maxAliasWindow ago, adjust the startTime to the earliest allowed
            if (startTime < minFirstSeenTimeMs) {
                startTime = minFirstSeenTimeMs;
                if (endTime < startTime) {
                    mParticle.Logger.warning(
                        'Source User has not been seen in the last ' +
                            mParticle.Store.SDKConfig.maxAliasWindow +
                            ' days, Alias Request will likely fail'
                    );
                }
            }
            return {
                destinationMpid: destinationUser.getMPID(),
                sourceMpid: sourceUser.getMPID(),
                startTime: startTime,
                endTime: endTime,
            };
        } catch (e) {
            mParticle.Logger.error(
                'There was a problem with creating an alias request: ' + e
            );
            return null;
        }
    },
};

/**
 * Invoke these methods on the mParticle.Identity.getCurrentUser() object.
 * Example: mParticle.Identity.getCurrentUser().getAllUserAttributes()
 * @class mParticle.Identity.getCurrentUser()
 */
function mParticleUser(mpid, isLoggedIn) {
    return {
        /**
         * Get user identities for current user
         * @method getUserIdentities
         * @return {Object} an object with userIdentities as its key
         */
        getUserIdentities: function() {
            var currentUserIdentities = {};

            var identities = Persistence.getUserIdentities(mpid);

            for (var identityType in identities) {
                if (identities.hasOwnProperty(identityType)) {
                    currentUserIdentities[
                        Types.IdentityType.getIdentityName(
                            Helpers.parseNumber(identityType)
                        )
                    ] = identities[identityType];
                }
            }

            return {
                userIdentities: currentUserIdentities,
            };
        },
        /**
         * Get the MPID of the current user
         * @method getMPID
         * @return {String} the current user MPID as a string
         */
        getMPID: function() {
            return mpid;
        },
        /**
         * Sets a user tag
         * @method setUserTag
         * @param {String} tagName
         */
        setUserTag: function(tagName) {
            if (!Validators.isValidKeyValue(tagName)) {
                mParticle.Logger.error(Messages.ErrorMessages.BadKey);
                return;
            }

            this.setUserAttribute(tagName, null);
        },
        /**
         * Removes a user tag
         * @method removeUserTag
         * @param {String} tagName
         */
        removeUserTag: function(tagName) {
            if (!Validators.isValidKeyValue(tagName)) {
                mParticle.Logger.error(Messages.ErrorMessages.BadKey);
                return;
            }

            this.removeUserAttribute(tagName);
        },
        /**
         * Sets a user attribute
         * @method setUserAttribute
         * @param {String} key
         * @param {String} value
         */
        setUserAttribute: function(key, newValue) {
            var cookies,
                userAttributes,
                previousUserAttributeValue,
                isNewAttribute;

            mParticle.sessionManager.resetSessionTimer();

            if (Helpers.canLog()) {
                if (!Validators.isValidAttributeValue(newValue)) {
                    mParticle.Logger.error(Messages.ErrorMessages.BadAttribute);
                    return;
                }

                if (!Validators.isValidKeyValue(key)) {
                    mParticle.Logger.error(Messages.ErrorMessages.BadKey);
                    return;
                }
                if (mParticle.Store.webviewBridgeEnabled) {
                    NativeSdkHelpers.sendToNative(
                        Constants.NativeSdkPaths.SetUserAttribute,
                        JSON.stringify({ key: key, value: newValue })
                    );
                } else {
                    cookies = Persistence.getPersistence();

                    userAttributes = this.getAllUserAttributes();

                    var existingProp = Helpers.findKeyInObject(
                        userAttributes,
                        key
                    );

                    if (existingProp) {
                        isNewAttribute = false;
                        previousUserAttributeValue =
                            userAttributes[existingProp];
                        delete userAttributes[existingProp];
                    } else {
                        isNewAttribute = true;
                    }

                    sendUserAttributeChangeEvent(
                        key,
                        newValue,
                        previousUserAttributeValue,
                        isNewAttribute,
                        false
                    );

                    userAttributes[key] = newValue;
                    if (cookies && cookies[mpid]) {
                        cookies[mpid].ua = userAttributes;
                        Persistence.saveCookies(cookies, mpid);
                    }

                    Forwarders.initForwarders(
                        IdentityAPI.getCurrentUser().getUserIdentities(),
                        ApiClient.prepareForwardingStats
                    );
                    Forwarders.callSetUserAttributeOnForwarders(key, newValue);
                }
            }
        },
        /**
         * Set multiple user attributes
         * @method setUserAttributes
         * @param {Object} user attribute object with keys of the attribute type, and value of the attribute value
         */
        setUserAttributes: function(userAttributes) {
            mParticle.sessionManager.resetSessionTimer();
            if (Helpers.isObject(userAttributes)) {
                if (Helpers.canLog()) {
                    for (var key in userAttributes) {
                        if (userAttributes.hasOwnProperty(key)) {
                            this.setUserAttribute(key, userAttributes[key]);
                        }
                    }
                }
            } else {
                mParticle.Logger.error(
                    'Must pass an object into setUserAttributes. You passed a ' +
                        typeof userAttributes
                );
            }
        },
        /**
         * Removes a specific user attribute
         * @method removeUserAttribute
         * @param {String} key
         */
        removeUserAttribute: function(key) {
            var cookies, userAttributes;
            mParticle.sessionManager.resetSessionTimer();

            if (!Validators.isValidKeyValue(key)) {
                mParticle.Logger.error(Messages.ErrorMessages.BadKey);
                return;
            }

            if (mParticle.Store.webviewBridgeEnabled) {
                NativeSdkHelpers.sendToNative(
                    Constants.NativeSdkPaths.RemoveUserAttribute,
                    JSON.stringify({ key: key, value: null })
                );
            } else {
                cookies = Persistence.getPersistence();

                userAttributes = this.getAllUserAttributes();

                sendUserAttributeChangeEvent(
                    key,
                    null,
                    userAttributes[key],
                    false,
                    true
                );

                var existingProp = Helpers.findKeyInObject(userAttributes, key);

                if (existingProp) {
                    key = existingProp;
                }

                delete userAttributes[key];

                if (cookies && cookies[mpid]) {
                    cookies[mpid].ua = userAttributes;
                    Persistence.saveCookies(cookies, mpid);
                }

                Forwarders.initForwarders(
                    IdentityAPI.getCurrentUser().getUserIdentities(),
                    ApiClient.prepareForwardingStats
                );
                Forwarders.applyToForwarders('removeUserAttribute', key);
            }
        },
        /**
         * Sets a list of user attributes
         * @method setUserAttributeList
         * @param {String} key
         * @param {Array} value an array of values
         */
        setUserAttributeList: function(key, newValue) {
            var cookies,
                userAttributes,
                previousUserAttributeValue,
                isNewAttribute,
                userAttributeChange;

            mParticle.sessionManager.resetSessionTimer();

            if (!Validators.isValidKeyValue(key)) {
                mParticle.Logger.error(Messages.ErrorMessages.BadKey);
                return;
            }

            if (!Array.isArray(newValue)) {
                mParticle.Logger.error(
                    'The value you passed in to setUserAttributeList must be an array. You passed in a ' +
                        typeof value
                );
                return;
            }

            var arrayCopy = newValue.slice();

            if (mParticle.Store.webviewBridgeEnabled) {
                NativeSdkHelpers.sendToNative(
                    Constants.NativeSdkPaths.SetUserAttributeList,
                    JSON.stringify({ key: key, value: arrayCopy })
                );
            } else {
                cookies = Persistence.getPersistence();

                userAttributes = this.getAllUserAttributes();

                var existingProp = Helpers.findKeyInObject(userAttributes, key);

                if (existingProp) {
                    isNewAttribute = false;
                    previousUserAttributeValue = userAttributes[existingProp];
                    delete userAttributes[existingProp];
                } else {
                    isNewAttribute = true;
                }

                if (ApiClient.shouldEnableBatching()) {
                    // If the new attributeList length is different previous, then there is a change event.
                    // Loop through new attributes list, see if they are all in the same index as previous user attributes list
                    // If there are any changes, break, and immediately send a userAttributeChangeEvent with full array as a value
                    if (
                        !previousUserAttributeValue ||
                        !Array.isArray(previousUserAttributeValue)
                    ) {
                        userAttributeChange = true;
                    } else if (
                        newValue.length !== previousUserAttributeValue.length
                    ) {
                        userAttributeChange = true;
                    } else {
                        for (var i = 0; i < newValue.length; i++) {
                            if (previousUserAttributeValue[i] !== newValue[i]) {
                                userAttributeChange = true;
                                break;
                            }
                        }
                    }

                    if (userAttributeChange) {
                        sendUserAttributeChangeEvent(
                            key,
                            newValue,
                            previousUserAttributeValue,
                            isNewAttribute,
                            false
                        );
                    }
                }

                userAttributes[key] = arrayCopy;
                if (cookies && cookies[mpid]) {
                    cookies[mpid].ua = userAttributes;
                    Persistence.saveCookies(cookies, mpid);
                }

                Forwarders.initForwarders(
                    IdentityAPI.getCurrentUser().getUserIdentities(),
                    ApiClient.prepareForwardingStats
                );
                Forwarders.callSetUserAttributeOnForwarders(key, arrayCopy);
            }
        },
        /**
         * Removes all user attributes
         * @method removeAllUserAttributes
         */
        removeAllUserAttributes: function() {
            var userAttributes;

            mParticle.sessionManager.resetSessionTimer();

            if (mParticle.Store.webviewBridgeEnabled) {
                NativeSdkHelpers.sendToNative(
                    Constants.NativeSdkPaths.RemoveAllUserAttributes
                );
            } else {
                userAttributes = this.getAllUserAttributes();

                Forwarders.initForwarders(
                    IdentityAPI.getCurrentUser().getUserIdentities(),
                    ApiClient.prepareForwardingStats
                );
                if (userAttributes) {
                    for (var prop in userAttributes) {
                        if (userAttributes.hasOwnProperty(prop)) {
                            Forwarders.applyToForwarders(
                                'removeUserAttribute',
                                prop
                            );
                        }
                        this.removeUserAttribute(prop);
                    }
                }
            }
        },
        /**
         * Returns all user attribute keys that have values that are arrays
         * @method getUserAttributesLists
         * @return {Object} an object of only keys with array values. Example: { attr1: [1, 2, 3], attr2: ['a', 'b', 'c'] }
         */
        getUserAttributesLists: function() {
            var userAttributes,
                userAttributesLists = {};

            userAttributes = this.getAllUserAttributes();
            for (var key in userAttributes) {
                if (
                    userAttributes.hasOwnProperty(key) &&
                    Array.isArray(userAttributes[key])
                ) {
                    userAttributesLists[key] = userAttributes[key].slice();
                }
            }

            return userAttributesLists;
        },
        /**
         * Returns all user attributes
         * @method getAllUserAttributes
         * @return {Object} an object of all user attributes. Example: { attr1: 'value1', attr2: ['a', 'b', 'c'] }
         */
        getAllUserAttributes: function() {
            var userAttributesCopy = {};
            var userAttributes = Persistence.getAllUserAttributes(mpid);

            if (userAttributes) {
                for (var prop in userAttributes) {
                    if (userAttributes.hasOwnProperty(prop)) {
                        if (Array.isArray(userAttributes[prop])) {
                            userAttributesCopy[prop] = userAttributes[
                                prop
                            ].slice();
                        } else {
                            userAttributesCopy[prop] = userAttributes[prop];
                        }
                    }
                }
            }

            return userAttributesCopy;
        },
        /**
         * Returns the cart object for the current user
         * @method getCart
         * @return a cart object
         */
        getCart: function() {
            return mParticleUserCart(mpid);
        },

        /**
         * Returns the Consent State stored locally for this user.
         * @method getConsentState
         * @return a ConsentState object
         */
        getConsentState: function() {
            return Persistence.getConsentState(mpid);
        },
        /**
         * Sets the Consent State stored locally for this user.
         * @method setConsentState
         * @param {Object} consent state
         */
        setConsentState: function(state) {
            Persistence.saveUserConsentStateToCookies(mpid, state);
            Forwarders.initForwarders(
                this.getUserIdentities().userIdentities,
                ApiClient.prepareForwardingStats
            );
        },
        isLoggedIn: function() {
            return isLoggedIn;
        },
        getLastSeenTime: function() {
            return Persistence.getLastSeenTime(mpid);
        },
        getFirstSeenTime: function() {
            return Persistence.getFirstSeenTime(mpid);
        },
    };
}

/**
 * Invoke these methods on the mParticle.Identity.getCurrentUser().getCart() object.
 * Example: mParticle.Identity.getCurrentUser().getCart().add(...);
 * @class mParticle.Identity.getCurrentUser().getCart()
 */
function mParticleUserCart(mpid) {
    return {
        /**
         * Adds a cart product to the user cart
         * @method add
         * @param {Object} product the product
         * @param {Boolean} [logEvent] a boolean to log adding of the cart object. If blank, no logging occurs.
         */
        add: function(product, logEvent) {
            var allProducts, userProducts, arrayCopy;

            arrayCopy = Array.isArray(product) ? product.slice() : [product];
            arrayCopy.forEach(function(product) {
                product.Attributes = Helpers.sanitizeAttributes(
                    product.Attributes
                );
            });

            if (mParticle.Store.webviewBridgeEnabled) {
                NativeSdkHelpers.sendToNative(
                    Constants.NativeSdkPaths.AddToCart,
                    JSON.stringify(arrayCopy)
                );
            } else {
                mParticle.sessionManager.resetSessionTimer();

                userProducts = Persistence.getUserProductsFromLS(mpid);

                userProducts = userProducts.concat(arrayCopy);

                if (logEvent === true) {
                    Events.logProductActionEvent(
                        Types.ProductActionType.AddToCart,
                        arrayCopy
                    );
                }

                var productsForMemory = {};
                productsForMemory[mpid] = { cp: userProducts };

                if (
                    userProducts.length > mParticle.Store.SDKConfig.maxProducts
                ) {
                    mParticle.Logger.verbose(
                        'The cart contains ' +
                            userProducts.length +
                            ' items. Only ' +
                            mParticle.Store.SDKConfig.maxProducts +
                            ' can currently be saved in cookies.'
                    );
                    userProducts = userProducts.slice(
                        -mParticle.Store.SDKConfig.maxProducts
                    );
                }

                allProducts = Persistence.getAllUserProductsFromLS();
                allProducts[mpid].cp = userProducts;

                Persistence.setCartProducts(allProducts);
            }
        },
        /**
         * Removes a cart product from the current user cart
         * @method remove
         * @param {Object} product the product
         * @param {Boolean} [logEvent] a boolean to log adding of the cart object. If blank, no logging occurs.
         */
        remove: function(product, logEvent) {
            var allProducts,
                userProducts,
                cartIndex = -1,
                cartItem = null;

            if (mParticle.Store.webviewBridgeEnabled) {
                NativeSdkHelpers.sendToNative(
                    Constants.NativeSdkPaths.RemoveFromCart,
                    JSON.stringify(product)
                );
            } else {
                mParticle.sessionManager.resetSessionTimer();

                userProducts = Persistence.getUserProductsFromLS(mpid);

                if (userProducts) {
                    userProducts.forEach(function(cartProduct, i) {
                        if (cartProduct.Sku === product.Sku) {
                            cartIndex = i;
                            cartItem = cartProduct;
                        }
                    });

                    if (cartIndex > -1) {
                        userProducts.splice(cartIndex, 1);

                        if (logEvent === true) {
                            Events.logProductActionEvent(
                                Types.ProductActionType.RemoveFromCart,
                                cartItem
                            );
                        }
                    }
                }

                var productsForMemory = {};
                productsForMemory[mpid] = { cp: userProducts };

                allProducts = Persistence.getAllUserProductsFromLS();

                allProducts[mpid].cp = userProducts;

                Persistence.setCartProducts(allProducts);
            }
        },
        /**
         * Clears the user's cart
         * @method clear
         */
        clear: function() {
            var allProducts;

            if (mParticle.Store.webviewBridgeEnabled) {
                NativeSdkHelpers.sendToNative(
                    Constants.NativeSdkPaths.ClearCart
                );
            } else {
                mParticle.sessionManager.resetSessionTimer();
                allProducts = Persistence.getAllUserProductsFromLS();

                if (allProducts && allProducts[mpid] && allProducts[mpid].cp) {
                    allProducts[mpid].cp = [];

                    allProducts[mpid].cp = [];

                    Persistence.setCartProducts(allProducts);
                }
            }
        },
        /**
         * Returns all cart products
         * @method getCartProducts
         * @return {Array} array of cart products
         */
        getCartProducts: function() {
            return Persistence.getCartProducts(mpid);
        },
    };
}

function parseIdentityResponse(
    xhr,
    previousMPID,
    callback,
    identityApiData,
    method
) {
    var prevUser = mParticle.Identity.getCurrentUser(),
        newUser,
        identityApiResult,
        indexOfMPID;
    var userIdentitiesForModify = {},
        userIdentities = prevUser
            ? prevUser.getUserIdentities().userIdentities
            : {};
    for (var identityKey in userIdentities) {
        userIdentitiesForModify[
            Types.IdentityType.getIdentityType(identityKey)
        ] = userIdentities[identityKey];
    }

    var newIdentities = {};

    mParticle.Store.identityCallInFlight = false;

    try {
        mParticle.Logger.verbose(
            'Parsing "' + method + '" identity response from server'
        );
        if (xhr.responseText) {
            identityApiResult = JSON.parse(xhr.responseText);
            sendUserIdentityChange(
                identityApiData,
                method,
                identityApiResult.mpid
            );

            if (identityApiResult.hasOwnProperty('is_logged_in')) {
                mParticle.Store.isLoggedIn = identityApiResult.is_logged_in;
            }
        }
        if (xhr.status === 200) {
            if (method === 'modify') {
                newIdentities = IdentityRequest.modifyUserIdentities(
                    userIdentitiesForModify,
                    identityApiData.userIdentities
                );
                Persistence.saveUserIdentitiesToCookies(
                    prevUser.getMPID(),
                    newIdentities
                );
            } else {
                identityApiResult = JSON.parse(xhr.responseText);

                mParticle.Logger.verbose(
                    'Successfully parsed Identity Response'
                );

                if (
                    !prevUser ||
                    (prevUser.getMPID() &&
                        identityApiResult.mpid &&
                        identityApiResult.mpid !== prevUser.getMPID())
                ) {
                    mParticle.Store.mpid = identityApiResult.mpid;
                    if (prevUser) {
                        Persistence.setLastSeenTime(previousMPID);
                    }
                    Persistence.setFirstSeenTime(identityApiResult.mpid);
                }

                //this covers an edge case where, users stored before "firstSeenTime" was introduced
                //will not have a value for "fst" until the current MPID changes, and in some cases,
                //the current MPID will never change
                if (
                    method === 'identify' &&
                    prevUser &&
                    identityApiResult.mpid === prevUser.getMPID()
                ) {
                    Persistence.setFirstSeenTime(identityApiResult.mpid);
                }

                indexOfMPID = mParticle.Store.currentSessionMPIDs.indexOf(
                    identityApiResult.mpid
                );

                if (
                    mParticle.Store.sessionId &&
                    identityApiResult.mpid &&
                    previousMPID !== identityApiResult.mpid &&
                    indexOfMPID < 0
                ) {
                    mParticle.Store.currentSessionMPIDs.push(
                        identityApiResult.mpid
                    );
                }

                if (indexOfMPID > -1) {
                    mParticle.Store.currentSessionMPIDs = mParticle.Store.currentSessionMPIDs
                        .slice(0, indexOfMPID)
                        .concat(
                            mParticle.Store.currentSessionMPIDs.slice(
                                indexOfMPID + 1,
                                mParticle.Store.currentSessionMPIDs.length
                            )
                        );
                    mParticle.Store.currentSessionMPIDs.push(
                        identityApiResult.mpid
                    );
                }

                Persistence.saveUserIdentitiesToCookies(
                    identityApiResult.mpid,
                    newIdentities
                );
                CookieSyncManager.attemptCookieSync(
                    previousMPID,
                    identityApiResult.mpid
                );

                checkIdentitySwap(
                    previousMPID,
                    identityApiResult.mpid,
                    mParticle.Store.currentSessionMPIDs
                );

                //if there is any previous migration data
                if (Object.keys(mParticle.Store.migrationData).length) {
                    newIdentities =
                        mParticle.Store.migrationData.userIdentities || {};
                    var userAttributes =
                        mParticle.Store.migrationData.userAttributes || {};
                    Persistence.saveUserAttributesToCookies(
                        identityApiResult.mpid,
                        userAttributes
                    );
                } else {
                    if (
                        identityApiData &&
                        identityApiData.userIdentities &&
                        Object.keys(identityApiData.userIdentities).length
                    ) {
                        newIdentities = IdentityRequest.modifyUserIdentities(
                            userIdentitiesForModify,
                            identityApiData.userIdentities
                        );
                    }
                }

                Persistence.saveUserIdentitiesToCookies(
                    identityApiResult.mpid,
                    newIdentities
                );
                Persistence.update();

                Persistence.findPrevCookiesBasedOnUI(identityApiData);

                mParticle.Store.context =
                    identityApiResult.context || mParticle.Store.context;
            }

            newUser = IdentityAPI.getCurrentUser();

            if (
                identityApiData &&
                identityApiData.onUserAlias &&
                Helpers.Validators.isFunction(identityApiData.onUserAlias)
            ) {
                try {
                    mParticle.Logger.warning(
                        'Deprecated function onUserAlias will be removed in future releases'
                    );
                    identityApiData.onUserAlias(prevUser, newUser);
                } catch (e) {
                    mParticle.Logger.error(
                        'There was an error with your onUserAlias function - ' +
                            e
                    );
                }
            }
            var cookies =
                Persistence.getCookie() || Persistence.getLocalStorage();

            if (newUser) {
                Persistence.storeDataInMemory(cookies, newUser.getMPID());
                if (
                    !prevUser ||
                    newUser.getMPID() !== prevUser.getMPID() ||
                    prevUser.isLoggedIn() !== newUser.isLoggedIn()
                ) {
                    Forwarders.initForwarders(
                        newUser.getUserIdentities().userIdentities,
                        ApiClient.prepareForwardingStats
                    );
                }
                Forwarders.setForwarderUserIdentities(
                    newUser.getUserIdentities().userIdentities
                );
                Forwarders.setForwarderOnIdentityComplete(newUser, method);
                Forwarders.setForwarderOnUserIdentified(newUser, method);
            }

            ApiClient.processQueuedEvents();
        }

        if (callback) {
            if (xhr.status === 0) {
                Helpers.invokeCallback(
                    callback,
                    HTTPCodes.noHttpCoverage,
                    identityApiResult || null,
                    newUser
                );
            } else {
                Helpers.invokeCallback(
                    callback,
                    xhr.status,
                    identityApiResult || null,
                    newUser
                );
            }
        } else {
            if (
                identityApiResult &&
                identityApiResult.errors &&
                identityApiResult.errors.length
            ) {
                mParticle.Logger.error(
                    'Received HTTP response code of ' +
                        xhr.status +
                        ' - ' +
                        identityApiResult.errors[0].message
                );
            }
        }
    } catch (e) {
        if (callback) {
            Helpers.invokeCallback(
                callback,
                xhr.status,
                identityApiResult || null
            );
        }
        mParticle.Logger.error(
            'Error parsing JSON response from Identity server: ' + e
        );
    }
}

// send a user identity change request on identify, login, logout, modify when any values change.
// compare what identities exist vs what it previously was for the specific user if they were in memory before.
// if it's the first time the user is logging in, send a user identity change request with created_this_batch = true
// created_this_batch is always false for old user

function sendUserIdentityChange(newIdentityApiData, method, mpid) {
    var userInMemory, userIdentitiesInMemory, userIdentityChangeEvent;

    if (!ApiClient.shouldEnableBatching()) {
        return;
    }

    if (!mpid) {
        if (method !== 'modify') {
            return;
        }
    }

    userInMemory =
        method === 'modify'
            ? IdentityAPI.getCurrentUser()
            : IdentityAPI.getUser(mpid);
    var newUserIdentities = newIdentityApiData.userIdentities;
    // if there is not a user in memory with this mpid, then it is a new user, and we send a user identity
    // change for each identity on the identity api request
    if (userInMemory) {
        userIdentitiesInMemory = userInMemory.getUserIdentities()
            ? userInMemory.getUserIdentities().userIdentities
            : {};
    } else {
        for (var identityType in newUserIdentities) {
            userIdentityChangeEvent = createUserIdentityChange(
                identityType,
                newUserIdentities[identityType],
                null,
                true
            );
            sendEventToServer(userIdentityChangeEvent);
        }
        return;
    }

    for (identityType in newUserIdentities) {
        if (
            userIdentitiesInMemory[identityType] !==
            newUserIdentities[identityType]
        ) {
            var isNewUserIdentityType = !userIdentitiesInMemory[identityType];
            userIdentityChangeEvent = createUserIdentityChange(
                identityType,
                newUserIdentities[identityType],
                userIdentitiesInMemory[identityType],
                isNewUserIdentityType
            );
            sendEventToServer(userIdentityChangeEvent);
        }
    }
}

function createUserIdentityChange(
    identityType,
    newIdentity,
    oldIdentity,
    newCreatedThisBatch
) {
    var userIdentityChangeEvent;

    userIdentityChangeEvent = ServerModel.createEventObject({
        messageType: Types.MessageType.UserIdentityChange,
        userIdentityChanges: {
            New: {
                IdentityType: identityType,
                Identity: newIdentity,
                CreatedThisBatch: newCreatedThisBatch,
            },
            Old: {
                IdentityType: identityType,
                Identity: oldIdentity,
                CreatedThisBatch: false,
            },
        },
    });

    return userIdentityChangeEvent;
}

function sendUserAttributeChangeEvent(
    attributeKey,
    newUserAttributeValue,
    previousUserAttributeValue,
    isNewAttribute,
    deleted
) {
    if (!ApiClient.shouldEnableBatching()) {
        return;
    }
    var userAttributeChangeEvent = createUserAttributeChange(
        attributeKey,
        newUserAttributeValue,
        previousUserAttributeValue,
        isNewAttribute,
        deleted
    );
    if (userAttributeChangeEvent) {
        sendEventToServer(userAttributeChangeEvent);
    }
}

function createUserAttributeChange(
    key,
    newValue,
    previousUserAttributeValue,
    isNewAttribute,
    deleted
) {
    if (!previousUserAttributeValue) {
        previousUserAttributeValue = null;
    }
    var userAttributeChangeEvent;
    if (newValue !== previousUserAttributeValue) {
        userAttributeChangeEvent = ServerModel.createEventObject({
            messageType: Types.MessageType.UserAttributeChange,
            userAttributeChanges: {
                UserAttributeName: key,
                New: newValue,
                Old: previousUserAttributeValue || null,
                Deleted: deleted,
                IsNewAttribute: isNewAttribute,
            },
        });
    }
    return userAttributeChangeEvent;
}

export default {
    checkIdentitySwap: checkIdentitySwap,
    IdentityRequest: IdentityRequest,
    IdentityAPI: IdentityAPI,
    mParticleUser: mParticleUser,
    mParticleUserCart: mParticleUserCart,
};
