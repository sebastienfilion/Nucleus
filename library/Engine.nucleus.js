"use strict";

/**
 * @fileOverview Define the Nucleus Engine class that is used to interface the action and event loop.
 *
 * @author Sebastien Filion
 */

const Promise = require('bluebird');
const childProcess = require('child_process');
const JSDocParserPath = require.resolve('jsdoc/jsdoc.js');
const fs = require('fs');
const path = require('path');
const uuid = require('uuid');

const NucleusAction = require('./Action.nucleus');
const NucleusDatastore = require('./Datastore.nucleus');
const NucleusError = require('./Error.nucleus');
const NucleusEvent = require('./Event.nucleus');
const NucleusResource = require('./Resource.nucleus');
const NucleusResourceRelationshipDatastore = require('./ResourceRelationshipDatastore.nucleus');

const nucleusValidator = require('./validator.nucleus');

const fsReadFilePromisified = Promise.promisify(fs.readFile);

const ACTION_CONFIGURATION_BY_ACTION_NAME_TABLE_NAME = 'ActionConfigurationByActionName';
const ACTION_QUEUE_NAME_BY_ACTION_NAME_ITEM_NAME_TABLE_NAME = 'ActionQueueNameByActionName';
const ACTION_QUEUE_NAME_SET_ITEM_NAME_TABLE_NAME = 'ActionQueueNameSet';
const EXTENDABLE_ACTION_CONFIGURATION_BY_ACTION_NAME_TABLE_NAME = 'ExtendableActionConfigurationByActionName';
const RESOURCE_STRUCTURE_BY_RESOURCE_TYPE_TABLE_NAME = 'ResourceStructureByResourceType';

const NODE_ENVIRONMENT = process.env.NODE_ENV || 'development';
const DEVELOPMENT_ENVIRONMENT_NAME = 'development';
const TESTING_ENVIRONMENT_NAME = 'testing';
const PRODUCTION_ENVIRONMENT_NAME = 'production';

const $$complexDataTypeRegularExpression = new RegExp(/([a-z]+)\.<[A-Za-z]+>/);
const $$engineFileNameRegularExpression = new RegExp(/.*engine\.js$/);
const $$javascriptReservedWordRegularExpressionList = [
  /\s*delete.+/,
  /\s*new Error\(.+/,
  /\s*new\s*.+'/,
  /\s*process\..+/
];


// NOTE: It seems like the system slows downs processing requests when there's a very high load (100+ requests under 25ms)
// The issue is caused mostly by how the requests get parallelized,
// One way to resolve this might be to create more redis connection on the fly.

class NucleusEngine {

  /**
   * Creates a Nucleus engine. The constructor returns a Proxy that interfaces the class and a Promise that resolves once
   * the engine is ready. If no datastore is passed in the option, a default connection will be created.
   *
   * @argument {String} name
   * @argument {Object} options
   * @argument {NucleusDatastore} [options.$actionDatastore]
   * @argument {NucleusDatastore} [options.$engineDatastore]
   * @argument {NucleusDatastore} [options.$eventDatastore]
   * @argument {NucleusResourceRelationshipDatastore} [options.$resourceRelationshipDatastore]
   * @argument {NucleusDatastore} [options.$logger]
   * @argument {Boolean} [options.automaticallyAutodiscover=false]
   * @argument {Boolean} [options.automaticallyManageResourceRelationship=false]
   * @argument {Boolean} [options.automaticallyRetrievePendingActions=false]
   * @argument {String} [options.defaultActionQueueName=<Engine's name>]
   *
   * @returns {Proxy}
   */
  constructor (engineName, options = {}) {
    const {
      $actionDatastore = new NucleusDatastore(`${engineName}ActionDatastore`),
      $engineDatastore = new NucleusDatastore(`${engineName}EngineDatastore`),
      $eventDatastore = new NucleusDatastore(`${engineName}EventDatastore`),
      $resourceRelationshipDatastore = new NucleusResourceRelationshipDatastore($engineDatastore),
      $logger = console,
      automaticallyAutodiscover = false,
      automaticallyManageResourceRelationship = false,
      automaticallyRetrievePendingActions = false,
      debounceActionExecution = true,
      defautlActionHangupTimeout = 1000 * 5,
      defaultActionQueueName = engineName
    } = options;

    /** @member {String} ID */
    Reflect.defineProperty(this, 'ID', { value: uuid.v1(), writable: false });
    /** @member {String} name */
    Reflect.defineProperty(this, 'name', { value: engineName, writable: false });

    // Debouncing the action execution allows a performance gain of 20% on heavy request load.
    this.debounceActionExecution = debounceActionExecution;
    this.defautlActionHangupTimeout = defautlActionHangupTimeout;
    this.defaultActionQueueName = defaultActionQueueName;

    if (
      $actionDatastore.type !== 'Redis' ||
      $engineDatastore !== 'Redis' ||
      $eventDatastore !== 'Redis'
    ) throw new NucleusError(`The action datastore, the engine datastore or the event datastore must be a Redis datastore adapter.`);

    this.$actionDatastore = $actionDatastore;
    this.$engineDatastore = this.$datastore = $engineDatastore;
    this.$eventDatastore = $eventDatastore;
    this.$eventSubscriberDatastore = this.$eventDatastore.duplicateConnection(`${this.name}EventSubscriberDatastore`);

    if (automaticallyManageResourceRelationship) this.$resourceRelationshipDatastore = $resourceRelationshipDatastore;

    this.$handlerDatastoreByName = {};
    this.eventHandlerByChannelName = {};

    this.$logger = $logger;

    this.actionTTL = 1000 * 60 * 60; // One hour
    this.eventTTL = 1000 * 60 * 5; // 5 minutes

    this.$logger.info(`Initializing the ${this.name} engine...`);

    // Execute everything needed during the initialization phase of the engine.
    this.$$promise = Promise.all([ this.$actionDatastore, this.$engineDatastore, this.$eventDatastore, this.$eventSubscriberDatastore ])
      .then(this.verifyRedisConfiguration.bind(this))
      .then(this.$datastore.createItem.bind(this.$datastore, 'EngineName', this.name, undefined))
      .then(() => { return this.$actionDatastore.addItemToSetByName(ACTION_QUEUE_NAME_SET_ITEM_NAME_TABLE_NAME, this.defaultActionQueueName); })
      // If the `automaticallyAutodiscover` flag is true, pass the engine directory path that should be set from the parent class.
      .then(() => { if (automaticallyAutodiscover) return this.autodiscover(this.engineDirectoryPath); })
      .then(() => { if (automaticallyRetrievePendingActions) return this.subscribeToActionQueueUpdate(this.defaultActionQueueName); })
      .then(this.fixDatastoreIssues.bind(this))
      .then(() => {

        return fsReadFilePromisified(path.join(__dirname, '/lua/handleEventQueuing.lua'), 'UTF8');
      })
      .then((handleEventQueuingScript) => {

        return this.$datastore.registerScriptByName('HandleEventQueuing', handleEventQueuingScript);
      })
      .then(() => {
        this.$logger.info(`The ${this.name} engine has successfully initialized.`);
      });

    const $$proxy = new Proxy(this, {
      get: function (object, property) {
        if (property in object) return (typeof object[property] === 'function') ? object[property].bind(object) : object[property];
        else if (property in object.$$promise) {
          return (typeof object.$$promise[property] === 'function') ? object.$$promise[property].bind(object.$$promise) : object.$$promise[property];
        }
        else undefined;
      }
    });

    return $$proxy;
  }

  /**
   * Autodiscovers the module's actions.
   *
   * @returns {Promise<{ actionConfigurationList: actionConfiguration[], extendableActionConfigurationList: extendableActionConfiguration[], resourceStructureList: resourceStructure[] }>}
   */
  async autodiscover (engineDirectoryPath = NucleusEngine.retrieveModuleDirectoryPath(this.name)) {
    // Retrieve all of the modules doclets using the JSDoc parser.
    const resourceAPIDocletList = await retrieveAllDocletsInPath(path.join(__dirname, '/ResourceAPI.nucleus.js'));
    const engineDocletList = await retrieveAllDocletsInPath(engineDirectoryPath);

    // Filter out doclets that does not have a "Nucleus" tag.
    const filteredDocletList = [].concat(engineDocletList, resourceAPIDocletList)
      .filter((doclet) => {

        return (nucleusValidator.isArray(doclet.tags)) ? doclet.tags[0].title === 'nucleus' : false;
      });

    // Collect all relevant data from the filtered doclet.
    const actionLikeConfigurationList = filteredDocletList
      .filter(({ kind }) => {

        return kind === 'function';
      })
      .map((doclet) => {
        const nucleusTagsByName = parseNucleusTag(doclet.tags);

        const argumentConfigurationByArgumentName = (doclet.params || [])
          .reduce((accumulator, { name: argumentName, optional: argumentIsOptional, type: { names: argumentTypeList } }) => {
            const cleanedArgumentType = nucleusValidator.shiftFirstLetterToLowerCase(argumentTypeList.join('|')).replace($$complexDataTypeRegularExpression, "$1");
            accumulator[argumentName] = (!!argumentIsOptional) ? `${cleanedArgumentType}?` : cleanedArgumentType;

            return accumulator;
          }, {});

        return Object.assign({
          actionSignature: doclet.meta.code.paramnames,
          argumentConfigurationByArgumentName,
          contextName: (doclet.memberof === `${this.name}Engine`) ? 'Self' : doclet.memberof,
          description: doclet.description,
          fileName: doclet.meta.filename,
          filePath: path.join(doclet.meta.path, doclet.meta.filename),
          methodName: doclet.name
        }, nucleusTagsByName);
      });

    const actionConfigurationList = actionLikeConfigurationList
      .filter(({ extendableActionName }) => {

        return !extendableActionName;
      });

    const extendableActionConfigurationList = actionLikeConfigurationList
      .filter(({ extendableActionName }) => {

        return !!extendableActionName;
      })
      .map((extendableActionConfiguration) => {
        const { extendableActionArgumentDefault } = extendableActionConfiguration;

        if (nucleusValidator.isArray(extendableActionArgumentDefault) && !nucleusValidator.isEmpty(extendableActionArgumentDefault)) {
          extendableActionConfiguration.extendableActionArgumentDefault = NucleusDatastore.parseHashItem(extendableActionArgumentDefault);
        }

        return extendableActionConfiguration;
      });

    const extendableActionConfigurationByActionName = extendableActionConfigurationList
      .reduce((accumulator, extendableActionConfiguration) => {
        const { actionName } = extendableActionConfiguration;

        accumulator[actionName] = extendableActionConfiguration;

        return accumulator;
      }, {});

    // Add every action to extend as a proto action configuration to the action configuration list.
    // All the other extendable properties will be parsed when the action is executed.
    actionConfigurationList
      .forEach(({ actionNameToExtend, filePath }, index) => {
        if (!actionNameToExtend) return;

        const { extendableActionName } = extendableActionConfigurationByActionName[actionNameToExtend];

        const context = require(filePath);

        const actionName = NucleusEngine.parseTemplateString(context, extendableActionName);

        actionConfigurationList[index].actionName = actionName;
      });

    const resourceStructureList = filteredDocletList
      .filter(({ kind }) => {

        return kind === 'typedef';
      })
      .map((doclet) => {
        const nucleusTagsByName = parseNucleusTag(doclet.tags);

        const propertiesByArgumentName = (doclet.properties || [])
          .reduce((accumulator, { name: argumentName, optional: argumentIsOptional, type: { names: argumentTypeList } }) => {
            const cleanedArgumentType = argumentTypeList.map(nucleusValidator.shiftFirstLetterToLowerCase).join('|').replace($$complexDataTypeRegularExpression, "$1");
            accumulator[argumentName] = (!!argumentIsOptional) ? `${cleanedArgumentType}?` : cleanedArgumentType;

            return accumulator;
          }, {});

        return Object.assign({
          resourceType: doclet.name,
          propertiesByArgumentName,
          contextName: (doclet.memberof === `${this.name}Engine`) ? 'Self' : doclet.memberof || `${doclet.name}API`,
          fileName: doclet.meta.filename,
          filePath: path.join(doclet.meta.path, doclet.meta.filename),
        }, nucleusTagsByName);
      });

    await this.storeActionConfiguration(actionConfigurationList);

    await this.storeExtendableActionConfiguration(extendableActionConfigurationList);

    await this.storeResourceStructure(resourceStructureList);

    return { actionConfigurationList, extendableActionConfigurationList, resourceStructureList };
  }

  /**
   * Destroys the engine and the related datastores.
   *
   * @returns {Promise}
   */
  async destroy () {
    const $datastoreList = [this.$actionDatastore, this.$engineDatastore, this.$eventDatastore, this.$eventSubscriberDatastore];

    Object.keys(this.$handlerDatastoreByName)
      .forEach((datastoreName) => {

        $datastoreList.push(this.$handlerDatastoreByName[datastoreName]);
      });

    this.$logger.info(`Destroying the ${this.name} engine and ${$datastoreList.length} datastore connection${($datastoreList.length > 1) ? 's' : ''}...`);

    return Promise.all($datastoreList
      .map(($datastore) => {

        return $datastore.destroy();
      }))
      .then(() => {
        this.$logger.info(`The ${this.name} engine has been destroyed.`);
      });
  }

  /**
   * Executes a pending action.
   *
   * @argument {NucleusAction} $action
   *
   * @returns {Promise<NucleusAction>}
   */
  async executeAction ($action) {
    const { ID: actionID, meta: { correlationID = uuid.v4(), originUserID = $action.meta.authorUserID }, name: actionName, originalMessage: actionMessage, } = $action;
    const actionItemKey = $action.generateOwnItemKey();

    try {
      // Retrieve the action configuration.
      const actionConfiguration = await this.retrieveActionConfigurationByActionName(actionName);

      if (nucleusValidator.isEmpty(actionConfiguration)) throw new NucleusError.UndefinedContextNucleusError(`Could not retrieve the configuration for action "${actionName}".`, { actionID, actionName });

      this.$logger.info(`Executing action "${actionName} (${actionID})"...`, { actionID, actionName, correlationID, originUserID });

      $action.updateStatus(NucleusAction.ProcessingActionStatus);
      await this.$actionDatastore.addItemToHashFieldByName(actionItemKey, 'meta', $action.meta.toString(), 'status', $action.status);

      // The action be executed from an action configuration or an extendable action configuration;
      const actionResponse = await (async function parseActionResponse () {
        const { actionNameToExtend } = actionConfiguration;

        if (!!actionNameToExtend) {
          const extendableActionConfiguration = await this.retrieveExtendableActionConfigurationByActionName(actionNameToExtend);

          if (nucleusValidator.isEmpty(extendableActionConfiguration)) throw new NucleusError.UndefinedContextNucleusError(`${actionNameToExtend} is not an extendable action.`, { actionID, actionName });

          const { extendableActionArgumentDefault = {}, actionAlternativeSignature, actionSignature = [], contextName = '', extendableEventName, filePath = '', methodName = '' } = extendableActionConfiguration;
          const argumentConfigurationByArgumentName = Object.assign({}, extendableActionConfiguration.argumentConfigurationByArgumentName, actionConfiguration.argumentConfigurationByArgumentName);

          const actionSignatureList = [ actionSignature, actionAlternativeSignature ];

          const actionToExtendContext = require(actionConfiguration.filePath);

          if ('extendableActionAlternativeSignature' in extendableActionConfiguration) {
            const extendedActionSignature = extendableActionConfiguration.extendableActionAlternativeSignature
              .map(NucleusEngine.parseTemplateString.bind(null, Object.assign({}, actionMessage, actionToExtendContext)));

            actionSignatureList.push(extendedActionSignature);
          }

          // Make sure that the message meets one of the proposed signature criteria.
          // Fulfil the action signature with the default arguments...
          const parsedExtendableActionArgumentDefault = await (async function parseExtendableActionArgumentDefault () {
            await Promise.all(Object.keys(extendableActionArgumentDefault)
              .map(async (key) => {
                const value = extendableActionArgumentDefault[key];
                const parsedValue = await NucleusEngine.parseTemplateString.call(this, Object.assign({}, actionMessage, actionToExtendContext), value);

                extendableActionArgumentDefault[key] = parsedValue;
              }));

            return extendableActionArgumentDefault;
          }).call(this);

          const fulfilledActionSignature = this.fulfilActionSignature($action, Object.assign({ originUserID }, parsedExtendableActionArgumentDefault, actionMessage), actionSignatureList, argumentConfigurationByArgumentName, parsedExtendableActionArgumentDefault);

          return this.executeMethodInContext($action, Object.assign({ originUserID }, parsedExtendableActionArgumentDefault, actionMessage), fulfilledActionSignature, contextName, filePath, methodName)
            .then((actionResponse) => {
              if (!extendableEventName) return actionResponse;

              const eventName = NucleusEngine.parseTemplateString.call(this, actionToExtendContext, extendableEventName);
              const $event = new NucleusEvent(eventName, actionResponse, { correlationID, originEngineID: this.ID, originEngineName: this.name, originProcessID: process.pid, originUserID });

              this.publishEventToChannelByName(eventName, $event);

              return actionResponse;
            });
        } else {
          const { argumentConfigurationByArgumentName = {}, actionSignature = [], actionAlternativeSignature, contextName = '',  eventName, filePath = '', methodName = '' } = actionConfiguration;

          // Make sure that the message meets one of the proposed signature criteria.
          const fulfilledActionSignature = this.fulfilActionSignature($action, Object.assign({ originUserID }, actionMessage), [ actionSignature, actionAlternativeSignature ], argumentConfigurationByArgumentName);

          return this.executeMethodInContext($action, Object.assign({ originUserID }, actionMessage), fulfilledActionSignature, contextName, filePath, methodName)
            .then((actionResponse) => {
              if (!eventName) return actionResponse;

              const $event = new NucleusEvent(eventName, actionResponse, { correlationID, originEngineID: this.ID, originEngineName: this.name, originProcessID: process.pid, originUserID });

              this.publishEventToChannelByName(eventName, $event);

              return actionResponse;
            });
        }
      }).call(this);

      $action.updateStatus(NucleusAction.CompletedActionStatus);
      $action.updateMessage(actionResponse);
      await this.$actionDatastore.addItemToHashFieldByName(actionItemKey, 'meta', $action.meta.toString(), 'status', $action.status, 'finalMessage', $action.finalMessage);

      // Temporarily removed because the events keys are kept but never handled and becomes stale.
      // Send event to action channel.
      // const $event = new NucleusEvent('ActionStatusUpdated', {
      //   actionFinalMessage: actionResponse,
      //   actionID,
      //   actionName,
      //   actionStatus: 'Completed'
      // });

      // await this.publishEventToChannelByName(`Action:${actionID}`, $event);

      this.$logger.debug(`The action "${actionName} (${actionID})" has been successfully executed.`, { actionID, actionName, correlationID, originUserID });

      return Promise.resolve($action);
    } catch (error) {
      if (!(error instanceof NucleusError)) error = new NucleusError(`The execution of the action "${actionName}" failed because of an external error: ${error}.`, { actionID, actionName, correlationID, error, originUserID });

      $action.updateStatus(NucleusAction.FailedActionStatus);
      $action.updateMessage({ error });
      await this.$actionDatastore.addItemToHashFieldByName(actionItemKey, 'meta', $action.meta.toString(), 'status', $action.status, 'finalMessage', $action.finalMessage);

      return Promise.reject(error);
    }
  }

  /**
   * Executes the action given its context.
   *
   * @argument {NucleusAction} $action
   * @argument {String[]} actionSignature
   * @argument {String} contextName=Self
   * @argument {String} filePath
   * @argument {String} methodName
   *
   * @returns {Promise<Object>}
   */
  async executeMethodInContext($action, actionMessage, actionSignature, contextName, filePath, methodName) {
    const argumentList = actionSignature
      .reduce((accumulator, argumentName) => {
        if (argumentName === 'options' && !('options' in actionMessage)) accumulator.push(actionMessage);
        else if (argumentName === 'originUserID') accumulator.push($action.originUserID);
        else if (argumentName === 'correlationID') accumulator.push($action.meta.correlationID);
        else accumulator.push(actionMessage[argumentName]);

        return accumulator;
      }, []);

    if (!actionSignature.includes('originUserID')) argumentList.push($action.originUserID);

    const $executionContext = ((contextName === 'Self')) ? this : require(filePath);

    if (nucleusValidator.isEmpty($executionContext[methodName])) throw new NucleusError.UndefinedContextNucleusError(`Could not execute the action ${$action.name} because the handler method could not be retrieved.`);

    const $augmentedLogger = NucleusEngine.augmentLogger(this.$logger, $action);

    const actionResponse = await $executionContext[methodName].apply((
      // If the action is part of the current engine, the context of the method to execute will be `this`...
      (contextName === 'Self')) ?
      this :
      // If the action is part of an external API file, the context will be either:
      // The local datastore and the local logger or...
      // The local datastore, the local logger and a relationship datastore, if available.
      (this.$resourceRelationshipDatastore) ?
        {$datastore: this.$datastore, $logger: $augmentedLogger, $resourceRelationshipDatastore: this.$resourceRelationshipDatastore} :
        {$datastore: this.$datastore, $logger: $augmentedLogger }, argumentList);

    return actionResponse;
  }

  /**
   * Fixes issues with the datastore; trying to normalize the data to avoid flushing everything when a change is made.
   *
   * @returns {Promise}
   */
  async fixDatastoreIssues() {
    const staleActionEventList = await this.$eventDatastore.$$server.keysAsync('Action:*');

    if (staleActionEventList.length === 0) return;
    // https://github.com/sebastienfilion/idex.nucleus/issues/3
    // The issue was due to action event being expired but not the channel event set used to manage event control flow.
    this.$logger.debug(`Removing old stale action channel ordered set. https://github.com/sebastienfilion/idex.nucleus/issues/3`);
    await this.$eventDatastore.evaluateLUAScript(`
local actionOrderedSetList = redis.call('KEYS', 'Action:*')

for index, itemKey in pairs(actionOrderedSetList) do
  redis.call('DEL', itemKey)
end
    `);
  }

  /**
   * Fulfils an action signature given different options and the argument configuration.
   *
   * @argument {NucleusAction} $action
   * @argument {Array[]} actionSignatureList
   * @argument {Object} argumentConfigurationByArgumentName
   *
   * @returns {String[]}
   */
  fulfilActionSignature($action, actionMessage, actionSignatureList, argumentConfigurationByArgumentName, defaults) {
    const actionMessageArgumentList = Object.keys(actionMessage);

    const fulfilledActionSignature = actionSignatureList
      .filter((argumentNameList) => {
        if (!argumentNameList) return false;

        return argumentNameList
          .reduce((accumulator, argumentName) => {
            if (argumentName === 'options') accumulator.push(argumentName);
            else if (argumentName === 'originUserID') accumulator.push(argumentName);
            else if (argumentName === 'correlationID') accumulator.push(argumentName);
            else if (actionMessageArgumentList.includes(argumentName)) accumulator.push(argumentName);

            return accumulator;
          }, []).length === argumentNameList.length;
      })[0];

    if (!fulfilledActionSignature) throw new NucleusError.UndefinedContextNucleusError("Can't execute the action because one or more argument is missing", {
      actionName: $action.name,
      actionSignatureList,
      actionMessagePropertyList: Object.keys(actionMessage)
    });

    if (!nucleusValidator.isEmpty(argumentConfigurationByArgumentName)) {
      if (!argumentConfigurationByArgumentName.hasOwnProperty('originUserID')) argumentConfigurationByArgumentName.originUserID = 'string';

      // Use the argument configuration object to validate the action's message property types.
      const validateActionArgument = nucleusValidator.struct(Object.keys(argumentConfigurationByArgumentName)
        .reduce((accumulator, argumentName) => {
          if (fulfilledActionSignature.includes(argumentName)) accumulator[argumentName] = argumentConfigurationByArgumentName[argumentName];

          return accumulator;
        }, {}));

      // Will throw an error if the action message does not validate.
      validateActionArgument(Object.keys(actionMessage)
        .reduce((accumulator, argumentName) => {
          if (fulfilledActionSignature.includes(argumentName)) accumulator[argumentName] = actionMessage[argumentName];

          return accumulator;
        }, {}));
    }

    return fulfilledActionSignature;
  }

  /**
   * Generates a Resource Model from a resource structure given the resource type.
   *
   * @argument {String} resourceType
   *
   * @returns {Promise<Function>}
   */
  async generateResourceModelFromResourceStructureByResourceType (resourceType) {
    const { propertiesByArgumentName = {} } = await this.retrieveResourceStructureByResourceType(resourceType) || {};

    return NucleusResource.bind(null, resourceType, propertiesByArgumentName);
  }

  /**
   * Subscribes and handles an event given a channel name.
   *
   * @argument {String} channelName
   * @argument {Function} handlerCallback
   *
   * @returns {Promise<Object>}
   */
  subscribeAndHandleEventByChannelName (channelName, handlerCallback) {
    if (!this.eventHandlerByChannelName.hasOwnProperty(channelName)) {
      this.eventHandlerByChannelName[channelName] = [];
      this.$eventSubscriberDatastore.subscribeToChannelName(channelName);

      this.$eventSubscriberDatastore.handleEventByChannelName(channelName, async ($event) => {
        const { meta: { correlationID } } = $event;
        const timestamp = Date.now();
        // Keep the event referenced for 5 minutes...
        const eventTTL = 1000 * 60 * 5;
        const eventItemKey = (correlationID) ? NucleusResource.generateItemKey($event.type, $event.name, correlationID) : $event.generateOwnItemKey();
        const [ eventWasHandled ] = await this.$engineDatastore.evaluateLUAScriptByName('HandleEventQueuing', 'HandledEventItemKeyList', timestamp, timestamp + eventTTL, eventItemKey);

        if (!!eventWasHandled) return;

        this.eventHandlerByChannelName[channelName]
          .map((handlerCallback) => {

            return handlerCallback.call(this, $event);
          });
      });
    }

    this.eventHandlerByChannelName[channelName].push(handlerCallback);
  }

  /**
   * Publishes an action given a queue name.
   * @example
   * const queueName = 'Dummy';
   * const $action = new NucleusAction('DummyAction', {});
   *
   * $engine.publishActionToQueueByName(queueName, $action);
   *
   * @argument {String} actionQueueName
   * @argument {NucleusAction} $action
   *
   * @returns {Promise<Object>}
   */
  async publishActionToQueueByName (actionQueueName, $action) {
    if (!nucleusValidator.isString(actionQueueName)) throw new NucleusError.UnexpectedValueTypeNucleusError("The action queue name must be a string.");
    if (!($action instanceof NucleusAction)) throw new NucleusError.UnexpectedValueTypeNucleusError("The action is not a valid Nucleus action.");
    const { ID: actionID, meta: { correlationID }, name: actionName } = $action;

    const { isMember: actionQueueNameRegistered } = await this.$actionDatastore.itemIsMemberOfSet(ACTION_QUEUE_NAME_SET_ITEM_NAME_TABLE_NAME, actionQueueName);

    if (!actionQueueNameRegistered) throw new NucleusError.UndefinedContextNucleusError(`The action queue name ${actionQueueName} doesn't exist or has not been properly registered.`);

    this.$logger.debug(`Publishing action "${actionName} (${actionID})" to action queue "${actionQueueName}"...`, { actionID, actionName, actionQueueName, correlationID });

    const actionKeyName = $action.generateOwnItemKey();

    $action.updateStatus(NucleusAction.PendingActionStatus);

    return this.$actionDatastore.$$server.multi()
      // Store the action as a hash item.
      .hmset(actionKeyName, 'ID', actionID, 'meta', $action.meta.toString(), 'name', actionName, 'status', $action.status, 'originalMessage', $action.originalMessage.toString(), 'originUserID', $action.originUserID)
      // Add the action key name into the appropriate action queue.
      .lpush(actionQueueName, actionKeyName)
      // Expire the action in a set TTL, the action should be kept a little while for debugging but not for too long to
      // prevent unnecessary memory bulk-up.
      .pexpire(actionKeyName, this.actionTTL)
      .execAsync()
      .tap(() => {
        this.$logger.debug(`The action "${actionName} (${actionID})" has been successfully published.`, { actionID, actionName, actionQueueName, correlationID });
      })
      .return({ actionQueueName, $action });
  }

  /**
   * Publishes an action given its name and a message, then handle the response.
   * @example
   * const { dummy } = await $engine.publishActionByNameAndHandleResponse('RetrieveDummyByID', { dummyID }, originUserID);
   *
   * @argument {String} actionName
   * @argument {Object} actionMessage
   * @argument {String} originUserID
   *
   * @returns {Promise<Object>}
   */
  async publishActionByNameAndHandleResponse (actionName, actionMessage = {}, options = {}) {
    const originUserID = (nucleusValidator.isObject(options)) ? options.originUserID : options;
    const correlationID = (nucleusValidator.isObject(options)) ? options.correlationID : undefined;
    
    if (!nucleusValidator.isString(actionName)) throw new NucleusError.UnexpectedValueTypeNucleusError("The action name must be a string.");
    if (!nucleusValidator.isObject(actionMessage)) throw new NucleusError.UnexpectedValueTypeNucleusError("The action message must be an object.");
    if (!originUserID) throw new NucleusError.UndefinedValueNucleusError("The origin user ID must be defined.");

    const actionQueueName = await this.$actionDatastore.retrieveItemFromHashFieldByName(ACTION_QUEUE_NAME_BY_ACTION_NAME_ITEM_NAME_TABLE_NAME, actionName);
    if (!nucleusValidator.isString(actionQueueName)) throw new NucleusError.UnexpectedValueTypeNucleusError(`Could not executed the action "${actionName}" because it wasn't registered properly.`);

    const $action = new NucleusAction(actionName, actionMessage, { correlationID, originEngineID: this.ID, originEngineName: this.name, originProcessID: process.pid, originUserID });

    const $$actionResponsePromise = new Promise(async (resolve, reject) => {
      const actionItemKey = $action.generateOwnItemKey();

      const actionDatastoreIndex = this.$actionDatastore.index;
      const $actionSubscriberDatastore = (this.$handlerDatastoreByName.hasOwnProperty('ActionSubscriber')) ?
        this.$handlerDatastoreByName['ActionSubscriber'] : (this.$handlerDatastoreByName['ActionSubscriber'] = this.$actionDatastore.duplicateConnection(`${this.name}ActionSubscriber`));

      await $actionSubscriberDatastore;

      const channelName = `__keyspace@${actionDatastoreIndex}__:${actionItemKey}`;

      $actionSubscriberDatastore.handleEventByChannelName(channelName, this.handleActionChannelRedisEvent.bind(this, $actionSubscriberDatastore, resolve, reject));

      await $actionSubscriberDatastore.subscribeToChannelName(channelName);

      if (!actionName) throw new NucleusError.UndefinedContextNucleusError(`Can't publish action "${actionName}" because the action queue couldn't be retrieved.`);

      try {

        process.nextTick(this.publishActionToQueueByName.bind(this, actionQueueName, $action));
      } catch (error) {

        reject(new NucleusError(`Could not publish the action because of an external error: ${error}`, { error }));
      }
    });

    return Promise.resolve($$actionResponsePromise);
  }

  /**
   * Handles an action channel's Redis events.
   * This is used to trigger a check of the action's status in the attempt of resolving a publisher's request.
   * _This method is tightly coupled with the #publishActionByNameAndHandleResponse and should be refactored._
   *
   * @argument {NucleusDatastore} $actionSubscriberDatastore
   * @argument {Promise.resolve} resolve - The resolver to call when the action is completed.
   * @argument {Promise.reject} reject - The rejecter to call when the action is failed.
   * @argument {String} channelName
   * @argument {String} redisCommand
   *
   * @returns {Promise<void>}
   */
  async handleActionChannelRedisEvent ($actionSubscriberDatastore, resolve, reject, channelName, redisCommand) {
    if (redisCommand !== 'hset' && redisCommand !== 'hmset') return;

    try {
      const [ keyspace, itemType, actionName, actionID ] = channelName.split(':');
      const actionItemKey = `${itemType}:${actionName}:${actionID}`;

      const { actionStatus } = await this.handleActionStatusUpdated(actionItemKey, actionID, actionName, resolve, reject);

      if (actionStatus === NucleusAction.CompletedActionStatus || actionStatus === NucleusAction.FailedActionStatus) {
        $actionSubscriberDatastore.unsubscribeFromChannelName(channelName);
      }

    } catch (error) {

      reject(new NucleusError(`Could not handle the action's response because of an external error: ${error}`, { error }));
    }
  }

  /**
   * Handles an action's status update.
   * _This method is tightly coupled with the #publishActionByNameAndHandleResponse and should be refactored._
   *
   * @argument {String} actionItemKey
   * @argument {String} actionID
   * @argument {String} actionName
   * @argument {Promise.resolve} [resolve]
   * @argument {Promise.reject} [reject]
   *
   * @returns {Promise}
   */
  async handleActionStatusUpdated (actionItemKey, actionID, actionName, resolve, reject) {
    const [ actionFinalMessage, actionStatus ] = await this.$actionDatastore.retrieveItemFromHashFieldByName(actionItemKey, 'finalMessage', 'status');

    if (actionStatus === NucleusAction.CompletedActionStatus || actionStatus === NucleusAction.FailedActionStatus) {
      this.$logger.debug(`The action "${actionName} (${actionID})" status has been updated to "${actionStatus}".`);
      // Resolve or reject the promise with the final message base on the action's status.
      if (actionStatus === NucleusAction.CompletedActionStatus) {
        if (resolve) resolve(actionFinalMessage);
        return Promise.resolve({ actionStatus, actionFinalMessage });
      }
      else if ('error' in actionFinalMessage) {
        const errorAttributes = actionFinalMessage.error;
        const NucleusErrorType = (Object.keys(NucleusError).includes(errorAttributes.name)) ? NucleusError[errorAttributes.name] : NucleusError;

        const error = new NucleusErrorType(errorAttributes.message, {error: errorAttributes});

        if (reject) reject(error);

        return Promise.reject({ actionStatus, error });
      } else (reject || Promise.reject)({ actionStatus });
    }

    return { actionStatus };
  }

  /**
   * Publishes an event given a channel name.
   * @example
   * const channelName = 'Dummy';
   * const $event = new NucleusEvent('DummyEvent', {});
   *
   * $engine.publishEventToChannelByName(channelName, $event);
   *
   * @argument {String} channelName
   * @argument {NucleusEvent} $event
   *
   * @returns {Promise<Object>}
   */
  publishEventToChannelByName (channelName, $event) {
    if (!nucleusValidator.isString(channelName)) throw new NucleusError.UnexpectedValueTypeNucleusError("The event channel name must be a string.");
    if (!($event instanceof NucleusEvent)) throw new NucleusError.UnexpectedValueTypeNucleusError("The event is not a valid Nucleus event.");
    const { ID: eventID, meta: { correlationID }, name: eventName } = $event;

    this.$logger.debug(`Publishing event "${eventName} (${eventID})" to channel "${channelName}"...`, { channelName, correlationID, eventID, eventName });

    const timestamp = Date.now();

    const eventKeyName = $event.generateOwnItemKey();

    return this.$eventDatastore.$$server.multi()
      // Store the event as a hash item.
      .hmset(eventKeyName, 'ID', $event.ID, 'message', $event.message.toString(), 'meta', $event.meta.toString(), 'name', $event.name)
      // Add the event key name to a local set.
      .zadd(channelName, timestamp + this.eventTTL, eventKeyName)
      // Remove older events from the set.
      .zremrangebyscore(channelName, 0, timestamp)
      // Expire the event in a set TTL.
      .pexpire(eventKeyName, this.eventTTL)
      // Publish the event through Redis for other engine.
      .publish(channelName, JSON.stringify($event))
      .execAsync()
      .tap(() => {
        this.$logger.debug(`The event "${eventName} (${eventID})" has been successfully published.`, { channelName, correlationID, eventID, eventName });
      })
      .return({ channelName, $event });
  }

  /**
   * Retrieves the action configurations given an action name.
   *
   * @argument {String} actionName
   *
   * @returns {Promise<actionConfiguration>}
   */
  retrieveActionConfigurationByActionName (actionName) {

    return this.$datastore.retrieveItemFromHashFieldByName(ACTION_CONFIGURATION_BY_ACTION_NAME_TABLE_NAME, actionName);
  }

  /**
   * Retrieves the extendable action configurations given an action name.
   *
   * @argument {String} actionName
   *
   * @returns {Promise<extendableActionConfiguration>}
   */
  retrieveExtendableActionConfigurationByActionName (actionName) {

    return this.$datastore.retrieveItemFromHashFieldByName(EXTENDABLE_ACTION_CONFIGURATION_BY_ACTION_NAME_TABLE_NAME, actionName);
  }

  /**
   * Retrieves a pending action name and call the execution.
   *
   * @argument {String} actionQueueName
   *
   * @returns {Promise<void>}
   */
  async retrievePendingAction (actionQueueName) {
    const $handlerDatastore = (this.$handlerDatastoreByName.hasOwnProperty(`${actionQueueName}Handler`)) ?
      this.$handlerDatastoreByName[`${actionQueueName}Handler`] :
      (this.$handlerDatastoreByName[`${actionQueueName}Handler`] = this.$actionDatastore.duplicateConnection(`${actionQueueName}Handler`));

    await $handlerDatastore;

    try {
      this.$logger.debug(`Retrieving a pending action from action queue "${actionQueueName}"...`, { actionQueueName });

      if (!$handlerDatastore.$$server.connected) throw new NucleusError.UnexpectedValueNucleusError(`The handler is not connected anymore.`);

      const actionItemKey = (await $handlerDatastore.$$server.brpopAsync(actionQueueName, 0))[1];

      // Special command used to tell the handler to stop trying to retrieve pending action.
      if (actionItemKey === '$$_ForceQuit') return;

      const $action = new NucleusAction(await (this.$actionDatastore.retrieveAllItemsFromHashByName(actionItemKey)));
      const { ID: actionID, meta: { correlationID }, name: actionName } = $action;

      this.$logger.debug(`Retrieved a pending action "${actionName} (${actionID})" from action queue "${actionQueueName}".`, { actionID, actionName, actionQueueName, correlationID });
      // if (NODE_ENVIRONMENT === DEVELOPMENT_ENVIRONMENT_NAME) {
      //   try {
      //     const actionQueueItemCount = await this.$actionDatastore.$$server.llenAsync(actionQueueName);
      //     this.$logger.debug(`${actionQueueName} action queue has ${actionQueueItemCount} pending action${(actionQueueItemCount > 1) ? 's' : ''} left.`);
      //
      //   } catch (e) {
      //     console.error(e);
      //   }
      // }

      process.nextTick(() => {
        this.executeAction($action)
          .catch((error) => {
            this.$logger.error(error.message, {
              actionID: $action.ID,
              actionName: $action.name,
              correlationID: $action.meta.correlationID,
              originUserID: $action.meta.originUserID,
              ...error
            });
          });
      });
    } catch (error) {
      this.$logger.warn(`Could not retrieve a pending action because of an error: ${error}`, {
        engineID: this.ID,
        engineName: this.name,
        error
      });
    }
  }

  /**
   * Retrieves the resource structure given a resource type.
   *
   * @argument {String} resourceType
   *
   * @returns {Promise<resourceStructure>}
   */
  retrieveResourceStructureByResourceType (resourceType) {

    return this.$datastore.retrieveItemFromHashFieldByName(RESOURCE_STRUCTURE_BY_RESOURCE_TYPE_TABLE_NAME, resourceType);
  }

  /**
   * Stores an action configuration.
   *
   * @argument {String} defaultActionQueueName
   * @argument {actionConfiguration} actionConfiguration
   *
   * @returns {Promise}
   */
  storeActionConfiguration (actionConfiguration) {
    /**
     * @typedef {Object} actionConfiguration
     * @property {String} actionName
     * @property {String[]} [alternativeActionSignature]
     * @property {String[]} [actionSignature]
     * @property {Object} [argumentConfigurationByArgumentName]
     * @property {String} contextName=Self
     * @property {String} [eventName]
     * @property {String} fileName
     * @property {String} filePath
     * @property {String} methodName
     */
    if (nucleusValidator.isArray(actionConfiguration)) {
      const actionConfigurationList = actionConfiguration;

      return Promise.all(actionConfigurationList.map(this.storeActionConfiguration.bind(this)));
    }

    const { actionName } = actionConfiguration;

    return Promise.all([
      this.$datastore.addItemToHashFieldByName(ACTION_CONFIGURATION_BY_ACTION_NAME_TABLE_NAME, actionName, actionConfiguration),
      this.$actionDatastore.addItemToHashFieldByName(ACTION_QUEUE_NAME_BY_ACTION_NAME_ITEM_NAME_TABLE_NAME, actionName, this.defaultActionQueueName)
    ]);
  }

  /**
   * Stores an extendable action configuration.
   *
   * @argument {extendableActionConfiguration} extendableActionConfiguration
   *
   * @returns {Promise}
   */
  storeExtendableActionConfiguration (extendableActionConfiguration) {
    /**
     * @typedef {Object} extendableActionConfiguration
     * @property {Object} extendableActionArgumentDefault
     * @property {String} actionName
     * @property {String[]} [alternativeActionSignature]
     * @property {String[]} [actionSignature]
     * @property {Object} [argumentConfigurationByArgumentName]
     * @property {String[]} [extendableActionAlternativeSignature]
     * @property {String} extendableActionName
     * @property {String} [extendableEventName]
     * @property {String} contextName=Self
     * @property {String} fileName
     * @property {String} filePath
     * @property {String} methodName
     */
    if (nucleusValidator.isArray(extendableActionConfiguration)) {
      const extendableActionConfigurationList = extendableActionConfiguration;

      return Promise.all(extendableActionConfigurationList.map(this.storeExtendableActionConfiguration.bind(this)));
    }

    const { actionName } = extendableActionConfiguration;

    return this.$datastore.addItemToHashFieldByName(EXTENDABLE_ACTION_CONFIGURATION_BY_ACTION_NAME_TABLE_NAME, actionName, extendableActionConfiguration);
  }

  /**
   * Stores a resource structure.
   *
   * @argument {resourceStructure} resourceStructure
   *
   * @returns {Promise}
   */
  storeResourceStructure (resourceStructure) {
    /**
     * @typedef {Object} resourceStructure
     * @property {String} contextName=Self
     * @property {String} fileName
     * @property {String} filePath
     * @property {Object} propertiesByArgumentName
     * @property {String} resourceAPIName
     * @property {String} resourceType
     */
    if (nucleusValidator.isArray(resourceStructure)) {
      const resourceStructureList = resourceStructure;

      return Promise.all(resourceStructureList.map(this.storeResourceStructure.bind(this)));
    }

    const { resourceType } = resourceStructure;

    return this.$datastore.addItemToHashFieldByName(RESOURCE_STRUCTURE_BY_RESOURCE_TYPE_TABLE_NAME, resourceType, resourceStructure);
  }

  /**
   * Subscribe to the action queue updates given its name.
   *
   * @argument {String} actionQueueName
   *
   * @returns {Promise<void>}
   */
  async subscribeToActionQueueUpdate (actionQueueName) {
    if (!nucleusValidator.isString(actionQueueName)) throw new NucleusError.UnexpectedValueTypeNucleusError("The action queue name must be a string.");

    const actionDatastoreIndex = this.$actionDatastore.index;
    const $actionQueueSubscriberDatastore = (this.$handlerDatastoreByName.hasOwnProperty(`${actionQueueName}Subscriber`)) ?
      this.$handlerDatastoreByName[`${actionQueueName}Subscriber`] :
      (this.$handlerDatastoreByName[`${actionQueueName}Subscriber`] = this.$actionDatastore.duplicateConnection(`${actionQueueName}Subscriber`));

    await $actionQueueSubscriberDatastore;

    try {
      const channelName = `__keyspace@${actionDatastoreIndex}__:${actionQueueName}`;

      // Debounces the request fixing an issue that would cause the system to slow down as more requests are made.
      let timeout;

      $actionQueueSubscriberDatastore.subscribeToChannelName(channelName);
      $actionQueueSubscriberDatastore.handleEventByChannelName(channelName, () => {
        if (this.debounceActionExecution) {
          clearTimeout(timeout);
          timeout = setTimeout(this.retrievePendingAction.bind(this, actionQueueName), 6);
        } else process.nextTick(this.retrievePendingAction.bind(this, actionQueueName));
      });

      return Promise.resolve();
    } catch (error) {

      return Promise.reject(error);
    }
  }

  /**
   * Subscribes to a channel given its name.
   *
   * @argument {String} channelName
   *
   * @returns {Promise<void>}
   */
  subscribeToEventChannelByName (channelName) {

    return this.$eventSubscriberDatastore.subscribeToChannelName(channelName);
  }

  /**
   * Unsubscribes to a channel given its name.
   *
   * @argument {String} channelName
   *
   * @returns {Promise<void>}
   */
  async unsubscribeFromEventChannelByName (channelName) {

    return this.$eventSubscriberDatastore.unsubscribeFromChannelName(channelName);
  }

  /**
   * Verifies that the Redises connection are configured correctly.
   *
   * @returns {Promise<void>}
   */
  async verifyRedisConfiguration () {
    const redisConnectionVerified = await this.$actionDatastore.$$server.existsAsync('RedisConnectionVerified');

    if (redisConnectionVerified) return;

    this.$logger.debug(`Verifying the ${this.name} engine's action datastore connection.`);

    try {
      const keyspaceNotificationActivated = (await this.$actionDatastore.evaluateLUAScript(`return redis.call('CONFIG', 'GET', 'notify-keyspace-events');`))[1];

      if (keyspaceNotificationActivated !== 'AKE') {
        this.$logger.error(`Redis' Keyspace Notification is not activated, please make sure to configure your Redis server correctly.
  # redis.conf
  # Check http://download.redis.io/redis-stable/redis.conf for more details.
  notify-keyspace-events AKE
  `);
        process.exit(699);
      }

      this.$logger.debug(`The ${this.name} engine's action datastore connection has been verified, all is good.`);

      // Make sure that the Engine datastore is configured correctly;
      // To avoid any surprise, there should be a save policy.
      const savePolicyActivated = (await this.$engineDatastore.evaluateLUAScript(`return redis.call('CONFIG', 'GET', 'save');`))[1];

      if (nucleusValidator.isEmpty(savePolicyActivated)) {
        this.$logger.warn(`Redis' Save policy is not activated; because Redis is used a as main store in certain cases, please make sure to configure your Redis server correctly.
  # redis.conf
  # Check http://download.redis.io/redis-stable/redis.conf for more details.
  save 900 1
  save 300 10
  save 60 10000
  `);
      }
    } catch (error) {
      this.$logger.debug(`Could not verify the ${this.name} engine's action datastore connection because of an error: ${error.message}.
Please make sure that everything is set-up properly. https://github.com/sebastienfilion/idex.nucleus/wiki`);
    }

    return this.$datastore.createItem('RedisConnectionVerified', this.ID, 60 * 60 * 7);
  }

  /**
   * Augments a logger with data from an action.
   *
   * @argument {Object|Console} $logger
   * @argument {NucleusAction} $action
   *
   * @returns {Object}
   */
  static augmentLogger ($logger, $action) {
    const { ID: actionID, meta: { correlationID }, name: actionName, originUserID } = $action;
    const loggerLevelNameList = [
      "error",
      "warn",
      "info",
      "log",
      "debug",
      "trace"
    ];
    const loggerWrapper = {};

    loggerLevelNameList
      .reduce((accumulator, loggerLevel) => {
        accumulator[loggerLevel] = function (message, meta = {}) {
          meta = Object.assign({}, meta, { correlationID, actionID, actionName, originUserID });

          return $logger[loggerLevel].call($logger, message, meta);
        };

        return accumulator;
      }, loggerWrapper);

    return loggerWrapper;
  }

  /**
   * Parses a template string.
   * @example
   * const parsedString = Nucleus.parseTemplateString({ world: "World" }, "`Hello ${world}!`");
   * // parsedString === 'Hello World!'
   *
   * @argument {Object} context
   * @argument {String} string
   *
   * @returns {Promise|*}
   */
  static parseTemplateString (context, string) {
    if (!nucleusValidator.isObject(context)) throw new NucleusError.UnexpectedValueTypeNucleusError("The context must be an object.");
    if (!nucleusValidator.isString(string)) throw new NucleusError.UnexpectedValueTypeNucleusError("The template string must be a string.");

    const Nucleus = {
      shiftFirstLetterToLowerCase: nucleusValidator.shiftFirstLetterToLowerCase
    };

    if (!!this && 'generateResourceModelFromResourceStructureByResourceType' in (this || {})) Nucleus.generateResourceModelFromResourceStructureByResourceType = this.generateResourceModelFromResourceStructureByResourceType;

    const propertyList = (string.match(/[A-Za-z0-9$\.\_\-]+/g) || [])
      .filter((propertyName) => {
        if (propertyName === '$') return false;

        return propertyName in context;
      });

    if (string.includes('Nucleus.generateResourceModelFromResourceStructureByResourceType')) {
      if (!('$datastore' in this) || !('generateResourceModelFromResourceStructureByResourceType' in this)) throw new NucleusError.UndefinedContextNucleusError("`Nucleus.generateResourceModelFromResourceStructureByResourceType` can't be called without a Nucleus Engine context. `NucleusEngine.parseTemplateString.apply($engine, argumentList)`");

      Nucleus.generateResourceModelFromResourceStructureByResourceType = this.generateResourceModelFromResourceStructureByResourceType.bind(this);
    }

    for (let $$javascriptReservedWordRegularExpression of $$javascriptReservedWordRegularExpressionList) {
      if ($$javascriptReservedWordRegularExpression.test(string)) throw new NucleusError(`Using certain JavaScript reserved words in unauthorized in a template string.`);
    }

    try {
      const evaluatedString = new Function('Nucleus', 'context', `
      const { ${propertyList.join(', ')} } = context;

      return ${string};
    `)(Nucleus, context);

      return evaluatedString;
    } catch (error) {

      throw new NucleusError(`Could not parse template string: "${string}" because of an external error.`, { error });
    }
  }

  /**
   * Retrieves the current module directory path.
   *
   * @argument {Object} [moduleNode=module.parent] - Used for recursion.
   * @argument {Object} [moduleNode] - Used for recursion.
   *
   * @returns {String}
   */
  static retrieveModuleDirectoryPath (moduleName, moduleNode = module.parent) {
    // NOTE: This doesn't work as expected because if multiple engine calls the Nucleus engine module, the first engine
    // to call it becomes the parent.
    if (nucleusValidator.isEmpty(moduleNode)) throw new NucleusError.UndefinedContextNucleusError(`Could not find any engine for the module "${moduleName}".`);

    if (!new RegExp(`.*${moduleName}.*`).test(moduleNode.filename)) return NucleusEngine.retrieveModuleDirectoryPath(moduleName, moduleNode.parent);
    else return path.dirname(moduleNode.filename);
  }

}

module.exports = NucleusEngine;

/**
 * Parses the Nucleus doclet tags.
 *
 * @argument {Array} docletTagList
 * @argument {String} docletTagList[].originalTitle=Nucleus
 * @argument {String} docletTagList[].title=nucleus
 * @argument {String} docletTagList[].text
 * @argument {String} docletTagList[].value
 *
 * @returns {Object}
 */
function parseNucleusTag (docletTagList) {

  return docletTagList
    .reduce((accumulator, { value }) => {
      const [ nucleusTagName, ...nucleusTagOptionList ] = value.split(" ");

      accumulator[nucleusValidator.shiftFirstLetterToLowerCase(nucleusTagName)] = (
        (nucleusTagOptionList.length === 1) ?
          nucleusTagOptionList[0] :
          nucleusTagOptionList
      );

      return accumulator;
    }, {});
}

/**
 * Retrieves all doclets in path.
 * @see {@link https://github.com/jsdoc3/jsdoc/blob/master/lib/jsdoc/doclet.js|JSDoc Doclet|}
 *
 * @argument {String} path
 *
 * @returns {Promise<doclet[]>}
 */
function retrieveAllDocletsInPath (path) {

  return new Promise((resolve, reject) => {
    const chunkList = [];
    const $$childProcess = childProcess.spawn('node', [ JSDocParserPath, '-X', '-r', path ], { cwd: process.cwd() });

    $$childProcess.stdout.setEncoding('utf8');
    $$childProcess.stderr.setEncoding('utf8');

    $$childProcess.stdout.on('data', chunkList.push.bind(chunkList));
    $$childProcess.stderr.on('data', reject);

    $$childProcess.on('close', () => {
      const docletList = JSON.parse(chunkList.join(''));

      resolve(docletList);
    });
    $$childProcess.on('error', reject);
  });
}
