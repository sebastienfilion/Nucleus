"use strict";

const Promise = require('bluebird');
const uuid = require('uuid');

const NucleusDatastore = require('./Datastore.nucleus');
const NucleusError = require('./Error.nucleus');
const NucleusResource = require('./Resource.nucleus');

const nucleusValidator = require('./validator.nucleus');

const RESOURCE_ID_BY_TYPE_TABLE_NAME = 'ResourceIDByType';
const WALK_HIERARCHY_METHOD_LIST = [
  'TopNodeDescent',
  'CurrentNodeDescent',
  'CurrentNode'
];
const HIERARCHY_TREE_CACHE_TTL = 10;

class NucleusResourceAPI {

  /**
   * Assigns one or many relationships to a resource given its ID.
   *
   * @Nucleus ActionName AssignRelationshipsToResourceByID
   * @Nucleus ExtendableActionName `AssignRelationshipsTo${resourceType}ByID`
   * @Nucleus ExtendableEventName `RelationshipsTo${resourceType}ByIDAssigned`
   * @Nucleus ExtendableAlternativeActionSignature 'resourceType' `${Nucleus.shiftFirstLetterToLowerCase(resourceType)}ID` 'originUserID'
   * @Nucleus ExtendableActionArgumentDefault resourceType `${resourceType}`
   *
   * @argument {String} resourceType
   * @argument {String} resourceID
   * @argument {Object[]} resourceRelationshipList
   * @argument {String} originUserID
   *
   * @returns {Promise<{ resourceID: String, resourceType: String, resourceRelationships: Object }>}
   *
   * @throws Will throw an error if the resource type is not a string.
   * @throws Will throw an error if the resource ID is not a string.
   * @throws Will throw an error if the origin user ID is not a string.
   */
  static async assignRelationshipsToResourceByID (resourceType, resourceID, resourceRelationshipList, originUserID) {
    if (!nucleusValidator.isString(resourceType)) throw new NucleusError.UnexpectedValueTypeNucleusError("The resource type must be a string.");
    if (!nucleusValidator.isString(resourceID)) throw new NucleusError.UnexpectedValueTypeNucleusError("The resource ID must be a string and can't be undefined.");
    if (!nucleusValidator.isString(originUserID) || nucleusValidator.isEmpty(originUserID)) throw new NucleusError.UnexpectedValueTypeNucleusError("The origin user ID must be a string and can't be undefined.");

    const { $datastore, $resourceRelationshipDatastore } = this;

    const resourceItemKey = NucleusResource.generateItemKey(resourceType, resourceID);

    const resourceExists = !!(await $datastore.$$server.existsAsync(resourceItemKey));

    if (!resourceExists) throw new NucleusError.UndefinedContextNucleusError(`The ${resourceType} ("${resourceID}") does not exist.`);

    const { canUpdateResource } = await NucleusResourceAPI.verifyThatUserCanUpdateResource.call(this, originUserID, resourceType, resourceID);

    if (!canUpdateResource) throw new NucleusError.UnauthorizedActionNucleusError(`The user ("${originUserID}") is not authorized to update the ${resourceType} ("${resourceID}")`);

    const resourceRelationships = {};

    return Promise.all(resourceRelationshipList.map(({ predicate, resourceID: objectResourceID, resourceType: objectResourceType }) => {
      if (!(predicate in resourceRelationships))
        resourceRelationships[predicate] = [];

      resourceRelationships[predicate].push({
        relationship: predicate,
        resourceID: objectResourceID,
        resourceType: objectResourceType
      });

      return $resourceRelationshipDatastore.createRelationshipBetweenSubjectAndObject(
        `${resourceType}-${resourceID}`,
        predicate,
        `${objectResourceType}-${objectResourceID}`
      );
    }))
      .return({ resourceID, resourceType, resourceRelationships });
  }

  /**
   * Creates a resource given its name and an object of its attributes.
   *
   * @Nucleus ActionName CreateResource
   * @Nucleus ActionAlternativeSignature resourceType NucleusResourceModel resourceAttributes originUserID
   * @Nucleus ExtendableActionName `Create${resourceType}`
   * @Nucleus ExtendableEventName `${resourceType}Created`
   * @Nucleus ExtendableAlternativeActionSignature 'resourceType' 'NucleusResourceModel' `${Nucleus.shiftFirstLetterToLowerCase(resourceType)}Attributes` 'originUserID'
   * @Nucleus ExtendableActionArgumentDefault resourceType `${resourceType}` NucleusResourceModel Nucleus.generateResourceModelFromResourceStructureByResourceType(`${resourceType}`)
   *
   * @argument {String} resourceType
   * @argument {Function} NucleusResourceModel
   * @argument {Object} resourceAttributes
   * @argument {String} originUserID
   * @argument {String} [parentNodeType]
   * @argument {String} [parentNodeID]
   *
   * @returns {Promise<{ resource: NucleusResource, resourceRelationships: Object }>}
   *
   * @throws Will throw an error if the resource type is not a string.
   * @throws Will throw an error if the resource model is not an instance of NucleusResource.
   * @throws Will throw an error if the resource attributes is not an object.
   * @throws Will throw an error if the origin user ID is not a string.
   * @throws Will throw an error if no datastore is passed.
   * @throws Will throw an error if the resource is not conform to the model.
   */
  static async createResource (resourceType, NucleusResourceModel, resourceAttributes, originUserID, parentNodeType, parentNodeID) {
    if (!nucleusValidator.isString(resourceType)) throw new NucleusError.UnexpectedValueTypeNucleusError("The resource type must be a string.");
    if (!nucleusValidator.isFunction(NucleusResourceModel)) throw new NucleusError.UnexpectedValueTypeNucleusError("The Nucleus resource model must be an instance of NucleusResource.");
    if (!nucleusValidator.isObject(resourceAttributes)) throw new NucleusError.UnexpectedValueTypeNucleusError("The resource attributes must be an object.");
    if (!nucleusValidator.isString(originUserID) || nucleusValidator.isEmpty(originUserID)) throw new NucleusError.UnexpectedValueTypeNucleusError("The origin user ID must be a string and can't be undefined.");

    if (!!parentNodeType && !parentNodeID) throw new NucleusError.UndefinedValueNucleusError("The parent node type is expected along with the parent node ID.");

    const { $datastore, $resourceRelationshipDatastore } = this;

    if (nucleusValidator.isEmpty($datastore)) throw new NucleusError.UndefinedContextNucleusError("No datastore is provided.");

    if (!$resourceRelationshipDatastore && (!parentNodeType || !parentNodeID)) throw new NucleusError(`Could not resolve the node which the origin user (${originUserID}) is member of.`);

    {
      const [ parentNode ] = (!!$resourceRelationshipDatastore && (!parentNodeID || !parentNodeType)) ? await $resourceRelationshipDatastore.retrieveObjectOfRelationshipWithSubject(`User-${originUserID}`, 'is-member-of') : [ { ID: parentNodeID, type: parentNodeType } ];

      if (!nucleusValidator.isEmpty(parentNode) && (!parentNodeType || !parentNodeID)) {
        parentNodeType = parentNode.type;
        parentNodeID = parentNode.ID;
      }

      if ((!parentNodeType || !parentNodeID) && parentNode !== 'SYSTEM') throw new NucleusError(`Could not retrieve the node which the origin user (${originUserID}) is member of.`);

      try {
        const reservedResourceID = resourceAttributes.ID;
        Reflect.deleteProperty(resourceAttributes, 'ID');
        Reflect.deleteProperty(resourceAttributes, 'meta');
        const $resource = new NucleusResourceModel(resourceAttributes, originUserID, reservedResourceID);
        const resourceItemKey = $resource.generateOwnItemKey();

        const resourceExists = !!(await $datastore.$$server.existsAsync(resourceItemKey));

        if (resourceExists) throw new NucleusError.UndefinedContextNucleusError(`The ${resourceType} ("${$resource.ID}") already exists.`);

        return Promise.all([
          $datastore.addItemToHashFieldByName(resourceItemKey, $resource),
          $datastore.addItemToSetByName(RESOURCE_ID_BY_TYPE_TABLE_NAME, resourceType, $resource.ID),
        ])
          .then(() => {
            if (!$resourceRelationshipDatastore) return;

            return Promise.all([
              $resourceRelationshipDatastore.createRelationshipBetweenSubjectAndObject(`${resourceType}-${$resource.ID}`, 'is-member-of', (parentNode === 'SYSTEM') ? 'SYSTEM' : `${parentNodeType}-${parentNodeID}`),
              // I am assuming the type of user... That could be changed eventually.
              $resourceRelationshipDatastore.createRelationshipBetweenSubjectAndObject(`${resourceType}-${$resource.ID}`, 'is-authored-by', `User-${originUserID}`)
            ]);
          })
          .return({
            resource: $resource,
            resourceRelationships: {
              'is-authored-by': [
                {
                  relationship: 'is-authored-by',
                  resourceID: originUserID,
                  resourceType: 'User'
                }
              ],
              'is-member-of': [
                {
                  relationship: 'is-member-of',
                  resourceID: (parentNode === 'SYSTEM') ? 'SYSTEM' : parentNodeID,
                  resourceType: parentNodeType || 'SYSTEM'
                }
              ]
            }
          });
      } catch (error) {

        throw new NucleusError(`Could not create ${resourceType} because of an external error: ${error}`, { error });
      }
    }
  }

  /**
   * Removes a resource given its name and ID.
   *
   * @Nucleus ActionName RemoveResourceByID
   * @Nucleus ActionAlternativeSignature resourceType NucleusResourceModel resourceID originUserID
   * @Nucleus ExtendableActionName `Remove${resourceType}ByID`
   * @Nucleus ExtendableEventName `${resourceType}ByIDRemoved`
   * @Nucleus ExtendableAlternativeActionSignature 'resourceType' `${Nucleus.shiftFirstLetterToLowerCase(resourceType)}ID` 'originUserID'
   * @Nucleus ExtendableActionArgumentDefault resourceType `${resourceType}`
   *
   * @argument {String} resourceType
   * @argument {String} resourceID
   * @argument {String} originUserID
   *
   * @returns {Promise<{ resourceID: String }>}
   *
   * @throws Will throw an error if the resource type is not a string.
   * @throws Will throw an error if the resource ID is not a string.
   * @throws Will throw an error if the origin user ID is not a string.
   * @throws Will throw an error if no datastore is passed.
   * @throws Will throw an error if the origin user is not authorized to remove the resource.
   * @throws Will throw an error if the resource does not exist.
   */
  static async removeResourceByID (resourceType, resourceID, originUserID) {
    if (!nucleusValidator.isString(resourceType)) throw new NucleusError.UnexpectedValueTypeNucleusError("The resource type must be a string.");
    if (!nucleusValidator.isString(resourceID)) throw new NucleusError.UnexpectedValueTypeNucleusError("The resource ID must be a string.");
    if (!nucleusValidator.isString(originUserID) || nucleusValidator.isEmpty(originUserID)) throw new NucleusError.UnexpectedValueTypeNucleusError("The origin user ID must be a string and can't be undefined.");

    const { $datastore, $resourceRelationshipDatastore } = this;

    if (nucleusValidator.isEmpty($datastore)) throw new NucleusError.UndefinedContextNucleusError("No datastore is provided.");

    const resourceItemKey = NucleusResource.generateItemKey(resourceType, resourceID);

    const resourceExists = !!(await $datastore.$$server.existsAsync(resourceItemKey));

    if (!resourceExists) throw new NucleusError.UndefinedContextNucleusError(`The ${resourceType} ("${resourceID}") does not exist.`);

    const { canUpdateResource } = await NucleusResourceAPI.verifyThatUserCanUpdateResource.call(this, originUserID, resourceType, resourceID);

    if (!canUpdateResource) throw new NucleusError.UnauthorizedActionNucleusError(`The user ("${originUserID}") is not authorized to remove the ${resourceType} ("${resourceID}")`);

    return Promise.all([
      $datastore.removeItemByName(resourceItemKey),
    ])
      .then(() => {
        if (!$resourceRelationshipDatastore) return;

        return $resourceRelationshipDatastore.removeAllRelationshipsToVector({ ID: resourceID, type: resourceType });
      })
      .return({ resourceID });
  }

  /**
   * Retrieves a resource given its ID.
   *
   * @Nucleus ActionName RetrieveResourceByID
   * @Nucleus ActionAlternativeSignature resourceType NucleusResourceModel resourceID originUserID
   * @Nucleus ExtendableActionName `Retrieve${resourceType}ByID`
   * @Nucleus ExtendableAlternativeActionSignature 'resourceType' 'NucleusResourceModel' `${Nucleus.shiftFirstLetterToLowerCase(resourceType)}ID` 'originUserID'
   * @Nucleus ExtendableActionArgumentDefault resourceType `${resourceType}` NucleusResourceModel Nucleus.generateResourceModelFromResourceStructureByResourceType(`${resourceType}`)
   *
   * @argument {String} resourceType
   * @argument {Function} NucleusResourceModel
   * @argument {String} resourceID
   * @argument {String} originUserID
   *
   * @returns {Promise<{ resource: NucleusResource, resourceRelationships: Object }>}
   *
   * @throws Will throw an error if the resource type is not a string.
   * @throws Will throw an error if the resource model is not an instance of NucleusResource.
   * @throws Will throw an error if the resource ID is not a string.
   * @throws Will throw an error if the origin user ID is not a string.
   * @throws Will throw an error if no datastore is passed.
   * @throws Will throw an error if the origin user is not authorized to retrieve the resource.
   * @throws Will throw an error if the resource does not exist.
   */
  static async retrieveResourceByID (resourceType, NucleusResourceModel, resourceID, originUserID) {
    if (!nucleusValidator.isString(resourceType)) throw new NucleusError.UnexpectedValueTypeNucleusError("The resource type must be a string.");
    if (!nucleusValidator.isFunction(NucleusResourceModel)) throw new NucleusError.UnexpectedValueTypeNucleusError("The Nucleus resource model must be an instance of NucleusResource.");
    if (!nucleusValidator.isString(resourceID)) throw new NucleusError.UnexpectedValueTypeNucleusError("The resource ID must be a string.");
    if (!nucleusValidator.isString(originUserID) || nucleusValidator.isEmpty(originUserID)) throw new NucleusError.UnexpectedValueTypeNucleusError("The origin user ID must be a string and can't be undefined.");

    const { $datastore, $resourceRelationshipDatastore } = this;

    if (nucleusValidator.isEmpty($datastore)) throw new NucleusError.UndefinedContextNucleusError("No datastore is provided.");

    const resourceItemKey = NucleusResource.generateItemKey(resourceType, resourceID);

    const resourceExists = !!(await $datastore.$$server.existsAsync(resourceItemKey));

    if (!resourceExists) throw new NucleusError.UndefinedContextNucleusError(`The ${resourceType} ("${resourceID}") does not exist.`);

    const { canRetrieveResource } = await NucleusResourceAPI.verifyThatUserCanRetrieveResource.call(this, originUserID, resourceType, resourceID);

    if (!canRetrieveResource) throw new NucleusError.UnauthorizedActionNucleusError(`The user ("${originUserID}") is not authorized to retrieve the ${resourceType} ("${resourceID}")`);

    return Promise.all([
      $datastore.retrieveAllItemsFromHashByName(resourceItemKey),
      $resourceRelationshipDatastore.retrieveAllRelationshipsForSubject({
        ID: resourceID,
        type: resourceType
      })
    ])
      .then(([ resourceAttributes, nodeRelationshipList ]) => {
        const $resource = new NucleusResourceModel(resourceAttributes, originUserID);
        const resourceRelationships = nodeRelationshipList
          .reduce((accumulator, { predicate: relationship, object: { ID: resourceID, type: resourceType } }) => {
            if (!(relationship in accumulator)) accumulator[relationship] = [];
            accumulator[relationship].push({ relationship, resourceID, resourceType });

            return accumulator;
          }, {});

        return { resource: $resource, resourceRelationships };
      });
  }

  /**
   * Retrieves a resource given its ID.
   *
   * @Nucleus ActionName RetrieveBatchResourceByIDList
   * @Nucleus ActionAlternativeSignature resourceType NucleusResourceModel resourceID originUserID
   * @Nucleus ExtendableActionName `RetrieveBatch${resourceType}ByIDList`
   * @Nucleus ExtendableAlternativeActionSignature 'resourceType' 'NucleusResourceModel' `${Nucleus.shiftFirstLetterToLowerCase(resourceType)}IDList` 'originUserID'
   * @Nucleus ExtendableActionArgumentDefault resourceType `${resourceType}` NucleusResourceModel Nucleus.generateResourceModelFromResourceStructureByResourceType(`${resourceType}`)
   *
   * @argument {String} resourceType
   * @argument {Function} NucleusResourceModel
   * @argument {String[]} resourceIDList
   * @argument {String} originUserID
   *
   * @returns {Promise<{ resourceList: Object[] }>}
   *
   * @throws Will throw an error if the resource type is not a string.
   * @throws Will throw an error if the resource model is not an instance of NucleusResource.
   * @throws Will throw an error if the resource ID is not a string.
   * @throws Will throw an error if the origin user ID is not a string.
   * @throws Will throw an error if no datastore is passed.
   * @throws Will throw an error if the origin user is not authorized to retrieve the resource.
   * @throws Will throw an error if the resource does not exist.
   */
  static retrieveBatchResourceByIDList (resourceType, NucleusResourceModel, resourceIDList, originUserID) {
    if (!nucleusValidator.isString(resourceType)) throw new NucleusError.UnexpectedValueTypeNucleusError("The resource type must be a string.");
    if (!nucleusValidator.isFunction(NucleusResourceModel)) throw new NucleusError.UnexpectedValueTypeNucleusError("The Nucleus resource model must be an instance of NucleusResource.");
    if (!nucleusValidator.isArray(resourceIDList)) throw new NucleusError.UnexpectedValueTypeNucleusError("The resource ID list must be an array.");
    if (!nucleusValidator.isString(originUserID) || nucleusValidator.isEmpty(originUserID)) throw new NucleusError.UnexpectedValueTypeNucleusError("The origin user ID must be a string and can't be undefined.");

    const { $datastore, $resourceRelationshipDatastore } = this;

    if (nucleusValidator.isEmpty($datastore)) throw new NucleusError.UndefinedContextNucleusError("No datastore is provided.");

    const resourceItemList = resourceIDList
      .map((resourceID) => {

        return NucleusResource.generateItemKey(resourceType, resourceID);
      });

    const itemDatastoreRequestList = resourceItemList
      .map((itemKey) => {

        return ['HGETALL', itemKey];
      });

    const $$itemListPromise = $datastore.$$server.multi(itemDatastoreRequestList).execAsync()
      .then(itemFields => itemFields.filter(Boolean).map(NucleusDatastore.parseHashItem).map(resourceAttributes => new NucleusResourceModel(resourceAttributes, originUserID)));

    const $$resourceRelationshipsListPromise = $resourceRelationshipDatastore.retrieveAllRelationshipsForSubject(resourceIDList
      .map((resourceID) => {

        return { ID: resourceID, type: resourceType };
      }));

    return Promise.all([$$itemListPromise, $$resourceRelationshipsListPromise])
      .then(([resourceList, nodeRelationshipListList]) => {

        return resourceList
          .reduce((accumulator, resource, index) => {
            const nodeRelationshipList = nodeRelationshipListList[index];

            const resourceRelationships = nodeRelationshipList
              .reduce((accumulator, {predicate: relationship, object: {ID: resourceID, type: resourceType}}) => {
                if (!(relationship in accumulator)) accumulator[relationship] = [];
                accumulator[relationship].push({relationship, resourceID, resourceType});

                return accumulator;
              }, {});

            accumulator.push({resource, resourceRelationships});

            return accumulator;
          }, []);
      })
      .then((resourceList) => {

        return { resourceList };
      });
  }

  /**
   * Retrieves all the resources given its type.
   * This is done base on the hierarchy of resources and the origin user ID.
   *
   * @argument {String} nodeType
   * @argument {String} originUserID
   * @argument {walkHierarchyTreeMethod} [originUserID]=[TopNodeDescent,CurrentNodeDescent,CurrentNode]
   *
   * @returns {Promise<{ resourceList: Node[] }>}
   */
  static async retrieveAllNodesByType (nodeType, originUserID, walkHierarchyTreeMethod = 'TopNodeDescent') {
    if (!nucleusValidator.isString(walkHierarchyTreeMethod) || !~WALK_HIERARCHY_METHOD_LIST.indexOf(walkHierarchyTreeMethod)) throw new NucleusError.UnexpectedValueTypeNucleusError(`The walk hierarchy method ("${walkHierarchyTreeMethod}") is not a valid method.`);

    const { $resourceRelationshipDatastore } = this;
    const anchorNodeIsList = [];

    switch (walkHierarchyTreeMethod) {
      case 'TopNodeDescent':
      {
        const userAncestorNodeList = await NucleusResourceAPI.walkHierarchyTreeUpward.call(this, { ID: originUserID, type: 'User' });
        const userDirectAncestorChildrenNodeList = await NucleusResourceAPI.walkHierarchyTreeDownward.call(this, userAncestorNodeList[0]);

        userAncestorNodeList.slice(0).concat(userDirectAncestorChildrenNodeList)
          .forEach(anchorNodeIsList.push.bind(anchorNodeIsList));

      }
        break;

      case 'CurrentNodeDescent':
      {
        const userCurrentNodeList = await $resourceRelationshipDatastore.retrieveObjectOfRelationshipWithSubject(`User-${originUserID}`, 'is-member-of');
        const userCurrentNodeChildrenNodeList = await NucleusResourceAPI.walkHierarchyTreeDownward.call(this, userCurrentNodeList[0]);

        userCurrentNodeList.slice(0).concat(userCurrentNodeChildrenNodeList)
          .forEach(anchorNodeIsList.push.bind(anchorNodeIsList));
      }
        break;

      case 'CurrentNode':
      {
        const userCurrentNodeList = await $resourceRelationshipDatastore.retrieveObjectOfRelationshipWithSubject(`User-${originUserID}`, 'is-member-of');

        anchorNodeIsList.push(userCurrentNodeList);
      }
        break;

      default:
        throw new NucleusError.UnexpectedValueNucleusError(`"${walkHierarchyTreeMethod}" is not a valid walking method of the hierarchy tree.`);
    }

    return Promise.all(anchorNodeIsList
      .map(anchorNodeID => $resourceRelationshipDatastore.retrieveAllNodesByTypeForAnchorNode.call(this, nodeType, anchorNodeID, 'is-member-of', originUserID)))
      .then((childrenNodeListList) => {

        return childrenNodeListList
          .reduce((accumulator, childrenNodeList) => {
            accumulator = accumulator.concat(childrenNodeList);

            return accumulator;
          }, []);
      });
  }

  /**
   * Retrieves all the resources based on its relationship with the object.
   *
   * @argument {String} resourceType
   * @argument {Function} NucleusResourceModel
   * @argument {String} objectResourceID
   * @argument {String} relationshipPredicate
   * @argument {String} originUserID
   *
   * @returns {Promise<{ resourceList: Node[] }>}
   */
  static retrieveAllNodesByRelationshipWithNodeByID (objectNodeType, objectNodeID, relationshipPredicate, originUserID) {
    const { $resourceRelationshipDatastore } = this;

    return $resourceRelationshipDatastore.retrieveSubjectOfRelationshipWithObject(`${objectNodeType}-${objectNodeID}`, relationshipPredicate)
      .then((nodeList) => {

        return Promise.all(nodeList
          .map(async (node) => {
            const { ID: resourceID, type: resourceType } = node;

            const { canRetrieveResource } = await NucleusResourceAPI.verifyThatUserCanRetrieveResource(originUserID, resourceType, resourceID);

            if (!canRetrieveResource) return;

            return node;
          }))
          .then((nodeList) => {

            return nodeList.filter(node => !!node);
          });
      });
  }

  /**
   * Updates a resource given its ID.
   *
   * @Nucleus ActionName RetrieveAllResourcesByType
   * @Nucleus ActionAlternativeSignature resourceType NucleusResourceModel originUserID
   * @Nucleus ExtendableActionName `RetrieveAll${pluralResourceType}`
   * @Nucleus ExtendableEventName `All${pluralResourceType}Retrieved`
   * @Nucleus ExtendableActionArgumentDefault resourceType `${resourceType}` NucleusResourceModel Nucleus.generateResourceModelFromResourceStructureByResourceType(`${resourceType}`)
   *
   * @argument {String} resourceType
   * @argument {Function} NucleusResourceModel
   * @argument {String} originUserID
   * @argument {String} [walkHierarchyTreeMethod]
   *
   * @returns {Promise<{ resourceList: Object[] }>}
   *
   * @throws Will throw an error if the resource type is not a string.
   * @throws Will throw an error if the origin user ID is not a string.
   * @throws Will throw an error if the walk hierarchy tree method not a string or is not a valid method.
   * @throws Will throw an error if no datastore is passed.
   */
  static retrieveAllResourcesByType (resourceType, NucleusResourceModel, originUserID, walkHierarchyTreeMethod = 'TopNodeDescent') {
    const { $datastore, $resourceRelationshipDatastore } = this;
    if (!nucleusValidator.isString(resourceType)) throw new NucleusError.UnexpectedValueTypeNucleusError("The resource type must be a string.");
    if (!nucleusValidator.isString(originUserID) || nucleusValidator.isEmpty(originUserID)) throw new NucleusError.UnexpectedValueTypeNucleusError("The origin user ID must be a string and can't be undefined.");

    return NucleusResourceAPI.retrieveAllNodesByType.call(this, resourceType, originUserID, walkHierarchyTreeMethod)
      .then((nodeList) => {

        return NucleusResourceAPI.extendNodeList.call({ $datastore, $resourceRelationshipDatastore }, nodeList, NucleusResourceModel, originUserID);
      })
      .then((resourceList) => {

        return { resourceList };
      });
  }

  static async retrieveAllResourcesByTypeForResourceByID (anchorResourceType, anchorResourceID, resourceType, NucleusResourceModel, originUserID) {
    const { $datastore, $resourceRelationshipDatastore } = this;

    const { canRetrieveResource } = await NucleusResourceAPI.verifyThatUserCanRetrieveResource.call(this, originUserID, anchorResourceType, anchorResourceID);

    if (!canRetrieveResource) throw new NucleusError.UnauthorizedActionNucleusError(`The user ("${originUserID}") is not authorized to retrieve anything from the ${anchorResourceType} ("${anchorResourceID}")`);

    const nodeList = await $resourceRelationshipDatastore.retrieveAllNodesByTypeForAnchorNode(resourceType, `${anchorResourceType}-${anchorResourceID}`);

    const resourceList = await NucleusResourceAPI.extendNodeList.call(this, nodeList, NucleusResourceModel, originUserID);

    return { resourceList };
  }

  static extendNodeList(nodeList = [], NucleusResourceModel, originUserID) {
    const { $datastore, $resourceRelationshipDatastore } = this;

    const itemDatastoreRequestList = nodeList
      .map(({ID, type}) => {
        const itemKey = NucleusResource.generateItemKey(type, ID);

        return ['HGETALL', itemKey];
      });

    const $$itemListPromise = $datastore.$$server.multi(itemDatastoreRequestList).execAsync()
    // NucleusResourceModel, shouldn't request the origin user ID here...
      .then(itemFields => itemFields.map(NucleusDatastore.parseHashItem).map(resourceAttributes => new NucleusResourceModel(resourceAttributes, originUserID)));

    const $$resourceRelationshipsListPromise = $resourceRelationshipDatastore.retrieveAllRelationshipsForSubject(nodeList);

    return Promise.all([$$itemListPromise, $$resourceRelationshipsListPromise])
      .then(([resourceList, nodeRelationshipListList]) => {

        return resourceList
          .reduce((accumulator, resource, index) => {
            const nodeRelationshipList = nodeRelationshipListList[index];

            const resourceRelationships = nodeRelationshipList
              .reduce((accumulator, {predicate: relationship, object: {ID: resourceID, type: resourceType}}) => {
                if (!(relationship in accumulator)) accumulator[relationship] = [];
                accumulator[relationship].push({relationship, resourceID, resourceType});

                return accumulator;
              }, {});

            accumulator.push({resource, resourceRelationships});

            return accumulator;
          }, []);
      });
  }

  /**
   * Assigns one or many relationships to a resource given its ID.
   *
   * @Nucleus ActionName UnassignRelationshipsToResourceByID
   * @Nucleus ExtendableActionName `UnassignRelationshipsTo${resourceType}ByID`
   * @Nucleus ExtendableEventName `RelationshipsTo${resourceType}ByIDUnassigned`
   * @Nucleus ExtendableAlternativeActionSignature 'resourceType' `${Nucleus.shiftFirstLetterToLowerCase(resourceType)}ID` 'originUserID'
   * @Nucleus ExtendableActionArgumentDefault resourceType `${resourceType}`
   *
   * @argument {String} resourceType
   * @argument {String} resourceID
   * @argument {Object[]} resourceRelationshipList
   * @argument {String} originUserID
   *
   * @returns {Promise<{ resourceID: String, resourceType: String, resourceRelationships: Object }>}
   *
   * @throws Will throw an error if the resource type is not a string.
   * @throws Will throw an error if the resource ID is not a string.
   * @throws Will throw an error if the origin user ID is not a string.
   */
  static async unassignRelationshipsToResourceByID (resourceType, resourceID, resourceRelationshipList, originUserID) {
    if (!nucleusValidator.isString(resourceType)) throw new NucleusError.UnexpectedValueTypeNucleusError("The resource type must be a string.");
    if (!nucleusValidator.isString(resourceID)) throw new NucleusError.UnexpectedValueTypeNucleusError("The resource ID must be a string and can't be undefined.");
    if (!nucleusValidator.isString(originUserID) || nucleusValidator.isEmpty(originUserID)) throw new NucleusError.UnexpectedValueTypeNucleusError("The origin user ID must be a string and can't be undefined.");

    const { $datastore, $resourceRelationshipDatastore } = this;

    const resourceItemKey = NucleusResource.generateItemKey(resourceType, resourceID);

    const resourceExists = !!(await $datastore.$$server.existsAsync(resourceItemKey));

    if (!resourceExists) throw new NucleusError.UndefinedContextNucleusError(`The ${resourceType} ("${resourceID}") does not exist.`);

    const { canUpdateResource } = await NucleusResourceAPI.verifyThatUserCanUpdateResource.call(this, originUserID, resourceType, resourceID);

    if (!canUpdateResource) throw new NucleusError.UnauthorizedActionNucleusError(`The user ("${originUserID}") is not authorized to update the ${resourceType} ("${resourceID}")`);

    return Promise.all(resourceRelationshipList.map(({ relationship: predicate, resourceID: objectResourceID, resourceType: objectResourceType }) => {

      return $resourceRelationshipDatastore.removeRelationshipBetweenSubjectAndObject(
        `${resourceType}-${resourceID}`,
        predicate,
        `${objectResourceType}-${objectResourceID}`
      );
    }))
      .return({ resourceID, resourceType });
  }

  /**
   * Updates a resource given its ID.
   *
   * @Nucleus ActionName UpdateResourceByID
   * @Nucleus ActionAlternativeSignature resourceType NucleusResourceModel resourceID resourceAttributes originUserID
   * @Nucleus ExtendableActionName `Update${resourceType}ByID`
   * @Nucleus ExtendableEventName `${resourceType}ByIDUpdated`
   * @Nucleus ExtendableAlternativeActionSignature 'resourceType' 'NucleusResourceModel' `${Nucleus.shiftFirstLetterToLowerCase(resourceType)}ID` `${Nucleus.shiftFirstLetterToLowerCase(resourceType)}Attributes` 'originUserID'
   * @Nucleus ExtendableActionArgumentDefault resourceType `${resourceType}` NucleusResourceModel Nucleus.generateResourceModelFromResourceStructureByResourceType(`${resourceType}`)
   *
   * @argument {String} resourceType
   * @argument {Function} NucleusResourceModel
   * @argument {String} resourceID
   * @argument {Object} resourceAttributes
   * @argument {String} originUserID
   *
   * @returns {Promise<{ resource: NucleusResource }>}
   *
   * @throws Will throw an error if the resource type is not a string.
   * @throws Will throw an error if the resource model is not an instance of NucleusResource.
   * @throws Will throw an error if the resource ID is not a string.
   * @throws Will throw an error if the resource attributes is not an object.
   * @throws Will throw an error if the origin user ID is not a string.
   * @throws Will throw an error if no datastore is passed.
   * @throws Will throw an error if the origin user is not authorized to retrieve the resource.
   * @throws Will throw an error if the resource does not exist.
   */
  static async updateResourceByID (resourceType, NucleusResourceModel, resourceID, resourceAttributes, originUserID) {
    if (!nucleusValidator.isString(resourceType)) throw new NucleusError.UnexpectedValueTypeNucleusError("The resource type must be a string.");
    if (!nucleusValidator.isFunction(NucleusResourceModel)) throw new NucleusError.UnexpectedValueTypeNucleusError("The Nucleus resource model must be an instance of NucleusResource.");
    if (!nucleusValidator.isString(resourceID)) throw new NucleusError.UnexpectedValueTypeNucleusError("The resource ID must be a string.");
    if (!nucleusValidator.isObject(resourceAttributes)) throw new NucleusError.UnexpectedValueTypeNucleusError("The resource attributes must be an object.");
    if (!nucleusValidator.isString(originUserID) || nucleusValidator.isEmpty(originUserID)) throw new NucleusError.UnexpectedValueTypeNucleusError("The origin user ID must be a string and can't be undefined.");

    const { $datastore, $resourceRelationshipDatastore } = this;

    if (nucleusValidator.isEmpty($datastore)) throw new NucleusError.UndefinedContextNucleusError("No datastore is provided.");

    const resourceItemKey = NucleusResource.generateItemKey(resourceType, resourceID);

    const resourceExists = !!(await $datastore.$$server.existsAsync(resourceItemKey));

    if (!resourceExists) throw new NucleusError.UndefinedContextNucleusError(`The ${resourceType} ("${resourceID}") does not exist.`);

    const { canUpdateResource } = await NucleusResourceAPI.verifyThatUserCanUpdateResource.call(this, originUserID, resourceType, resourceID);

    if (!canUpdateResource) throw new NucleusError.UnauthorizedActionNucleusError(`The user ("${originUserID}") is not authorized to update the ${resourceType} ("${resourceID}")`);

    return Promise.all([
      $datastore.retrieveAllItemsFromHashByName(resourceItemKey),
      $resourceRelationshipDatastore.retrieveAllRelationshipsForSubject({
        ID: resourceID,
        type: resourceType
      })
    ])
      .then(async ([ staleResourceAttributes, nodeRelationshipList ]) => {
        const updatedISOTime = new Date().toISOString();
        staleResourceAttributes.meta = Object.assign({ updatedISOTime }, staleResourceAttributes.meta);

        Reflect.deleteProperty(resourceAttributes, 'ID');
        Reflect.deleteProperty(resourceAttributes, 'meta');

        const $resource = new NucleusResourceModel(Object.assign({}, staleResourceAttributes, resourceAttributes), originUserID);

        $resource.meta.updatedISOTime = new Date().toISOString();

        await $datastore.addItemToHashFieldByName(resourceItemKey, Object.assign({}, { meta: $resource.meta }, resourceAttributes));

        const resourceRelationships = nodeRelationshipList
          .reduce((accumulator, { predicate: relationship, object: { ID: resourceID, type: resourceType } }) => {
            if (!(relationship in accumulator)) accumulator[relationship] = [];
            accumulator[relationship].push({ relationship, resourceID, resourceType });

            return accumulator;
          }, {});

        return { resource: $resource, resourceRelationships };
      });
  }

  /**
   * @typedef {Object} Node - Represents a node in a hierarchy tree.
   * @property {String} ID
   * @property {String} type
   */

  /**
   * Verifies that the user can retrieve a given resource based on the hierarchy.
   *
   * @argument userID
   * @argument resourceID
   *
   * @returns {Promise<{ canRetrieveResource: Boolean }>}
   */
  static async verifyThatUserCanRetrieveResource (userID, resourceType, resourceID) {
    const { $resourceRelationshipDatastore } = this;

    if (!$resourceRelationshipDatastore) return { canRetrieveResource: true };

    const userAncestorNodeList = await NucleusResourceAPI.walkHierarchyTreeUpward.call(this, { ID: userID, type: 'User' });
    const userDirectAncestorChildrenNodeList = await NucleusResourceAPI.walkHierarchyTreeDownward.call(this, userAncestorNodeList[0]);
    const resourceAncestorNodeList = await NucleusResourceAPI.walkHierarchyTreeUpward.call(this, { ID: resourceID, type: resourceType });

    const nodeIDIntersectionList = userAncestorNodeList.slice(0).concat(userDirectAncestorChildrenNodeList)
      .filter((node) => {

        return resourceAncestorNodeList
          .reduce((accumulator, ancestorNode) => {
            if (ancestorNode.ID === node.ID) accumulator.push(node);

            return accumulator;
          }, []).length > 0;
      });

    if (nodeIDIntersectionList.length === 0) return { canRetrieveResource: false };

    return { canRetrieveResource: true };
  }

  /**
   * Verifies that the user can update a given resource based on the hierarchy.
   *
   * @argument userID
   * @argument resourceID
   *
   * @returns {Promise<{ canUpdateResource: Boolean }>}
   */
  static async verifyThatUserCanUpdateResource (userID, resourceType, resourceID) {
    const { $resourceRelationshipDatastore } = this;

    if (!$resourceRelationshipDatastore) return { canUpdateResource: true };

    const userDirectAncestorNodeList = await $resourceRelationshipDatastore.retrieveObjectOfRelationshipWithSubject(`User-${userID}`, 'is-member-of');

    if (userDirectAncestorNodeList[0].type === resourceType && userDirectAncestorNodeList[0].ID === resourceID) return { canUpdateResource: true };

    const userDirectAncestorChildrenNodeList = await NucleusResourceAPI.walkHierarchyTreeDownward.call(this, userDirectAncestorNodeList[0]);
    const resourceAncestorNodeList = await NucleusResourceAPI.walkHierarchyTreeUpward.call(this, { ID: resourceID, type: resourceType });

    const nodeIDIntersectionList = userDirectAncestorNodeList.slice(0).concat(userDirectAncestorChildrenNodeList)
      .filter((node) => {

        return resourceAncestorNodeList
          .reduce((accumulator, ancestorNode) => {
            if (ancestorNode.ID === node.ID) accumulator.push(node);

            return accumulator;
          }, []).length > 0;
      });

    if (nodeIDIntersectionList.length === 0) return { canUpdateResource: false };

    return { canUpdateResource: true };
  }

  /**
   * Recursively walks down all the branches of a given resource and collect every children.
   *
   * @argument {Node} node
   * @argument {Number} [depth=Infinity]
   *
   * @returns {Promise<String[]>}
   */
  static async walkHierarchyTreeDownward (node, depth = Infinity) {
    const { $datastore, $resourceRelationshipDatastore } = this;

    if (!$resourceRelationshipDatastore) return [];

    const cachedNodeList = await $datastore.retrieveItemByName(`NodeList:HierarchyTreeDownward:${node.ID}`);

    if (!!cachedNodeList) return Promise.resolve(cachedNodeList);

    const nodeList = [];
    const nodeIDList = [];

    async function retrieveChildrenForNodeByID (node) {
      const childrenNodeList = await $resourceRelationshipDatastore.retrieveSubjectOfRelationshipWithObject(node, 'is-member-of');

      if (childrenNodeList.length === 0 || !!~childrenNodeList.indexOf('SYSTEM')) return null;

      childrenNodeList
        .forEach((node) => {
          const { ID: nodeID, type: nodeType } = node;

          if (!nodeIDList.includes(nodeID)) {
            nodeList.push(node);
            nodeIDList.push(`${nodeType}-${nodeID}`);
          }
        });

      if (nodeList.length >= depth) return;

      return Promise.all(childrenNodeList
        .map(retrieveChildrenForNodeByID.bind(this)));
    }

    return new Promise(async (resolve) => {
      await retrieveChildrenForNodeByID.call(this, node);

      try {
        await $datastore.createItem(`NodeList:HierarchyTreeDownward:${node.ID}`, nodeList, HIERARCHY_TREE_CACHE_TTL);
      } catch (error) {
        reject(error);
      }

      resolve(nodeList);
    });
  }

  /**
   * Recursively walks up all the branches of a given resource and collect every ancestors.
   *
   * @argument {Node} node
   * @argument {Number} [depth=Infinity]
   *
   * @returns {Promise<Node[]>}
   */
  static async walkHierarchyTreeUpward (node, depth = Infinity) {
    const { $datastore, $resourceRelationshipDatastore } = this;

    if (!$resourceRelationshipDatastore) return [];

    const cachedNodeList = await $datastore.retrieveItemByName(`NodeList:HierarchyTreeUpward:${node.ID}`);

    if (!!cachedNodeList) return Promise.resolve(cachedNodeList);

    const nodeList = [];
    const nodeIDList = [];

    async function retrieveAncestorForNodeByID (nodeID) {
      const ancestorNodeList = await $resourceRelationshipDatastore.retrieveObjectOfRelationshipWithSubject(nodeID, 'is-member-of');

      if (ancestorNodeList.length === 0 || !!~ancestorNodeList.indexOf('SYSTEM')) return null;

      ancestorNodeList
        .forEach((node) => {
          const { ID: nodeID, type: nodeType } = node;

          if (!~nodeIDList.indexOf(nodeID)) {
            nodeList.push(node);
            nodeIDList.push(`${nodeType}-${nodeID}`);
          }
        }, nodeList);

      if (nodeList.length >= depth) return;

      return Promise.all(ancestorNodeList
        .map(retrieveAncestorForNodeByID.bind(this)));
    }

    return new Promise(async (resolve, reject) => {
      await retrieveAncestorForNodeByID.call(this, node);

      try {
        await $datastore.createItem(`NodeList:HierarchyTreeUpward:${node.ID}`, nodeList, HIERARCHY_TREE_CACHE_TTL);
      } catch (error) {
        reject(error);
      }

      resolve(nodeList);
    });
  }
}

module.exports = NucleusResourceAPI;