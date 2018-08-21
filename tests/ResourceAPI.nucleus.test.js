"use strict";

const Promise = require('bluebird');
const chai = require('chai');
const chaiAsPromised = require('chai-as-promised');
const mocha = require('mocha');
const uuid = require('uuid');
const sinon = require('sinon');

chai.use(chaiAsPromised);

const NucleusDatastore = require('../library/Datastore.nucleus');
const NucleusError = require('../library/Error.nucleus');
const NucleusResource = require('../library/Resource.nucleus');
const NucleusResourceAPI = require('../library/ResourceAPI.nucleus');
const NucleusResourceRelationshipDatastore = require('../library/ResourceRelationshipDatastore.nucleus');
const nucleusValidator = require('../library/validator.nucleus');

const DATASTORE_INDEX = 0;
const DATASTORE_URL = 'localhost';
const DATASTORE_PORT = 6379;

const resourceName = 'Dummy';

const $$nodeTypeNodeIDRegularExpression = new RegExp(`^(${nucleusValidator.pascalCaseRegularExpression})-(${nucleusValidator.UUIDRegularExpression})$`);

class DummyResourceModel extends NucleusResource {

  constructor (resourceAttributes, authorUserID) {
    super('Dummy', { name: 'string' }, resourceAttributes, authorUserID);
  }

}

mocha.suite.only("Nucleus Resource API", function () {

  mocha.suiteSetup(function () {
    const $datastore = new NucleusDatastore('Test', {
      index: DATASTORE_INDEX,
      URL: DATASTORE_URL,
      port: DATASTORE_PORT
    });

    const $resourceRelationshipDatastore = new NucleusResourceRelationshipDatastore($datastore);

    Reflect.defineProperty(this, '$datastore', {
      value: $datastore,
      writable: false
    });

    Reflect.defineProperty(this, '$resourceRelationshipDatastore', {
      value: $resourceRelationshipDatastore,
      writable: false
    });

    return Promise.all([
      $datastore,
      $resourceRelationshipDatastore
    ]);
  });

  mocha.suiteSetup(function () {
    const $$sandbox = sinon.createSandbox();

    Reflect.defineProperty(this, '$$sandbox', {
      value: $$sandbox,
      writable: false
    });
  });

  mocha.suiteSetup(function () {
    const { $datastore } = this;

    return $datastore.$$server.flushallAsync();
  });

  mocha.suiteTeardown(function () {
    const { $datastore } = this;

    return $datastore.$$server.flushallAsync();
  });

  mocha.suiteTeardown(function () {
    const { $datastore } = this;

    return $datastore.destroy();
  });

  mocha.suite("Hierarchy tree", function () {

    mocha.suite("Simple direct branch", function () {

      mocha.setup(function () {
        const { $resourceRelationshipDatastore } = this;

        // Considering this list of ID, "SYSTEM" being the ancestor of nodeList[1] and so on and nodeList[3] being the leaf.
        const branchNodeIDList = ['SYSTEM', uuid.v4(), uuid.v4(), uuid.v4(), uuid.v4(), uuid.v4(),];

        Reflect.defineProperty(this, 'branchNodeIDList', {
          value: branchNodeIDList,
          writable: false
        });

        return Promise.all(branchNodeIDList
          .slice(0)
          .reverse()
          .map((nodeID, index, array) => {
            const ancestorNodeID = array[index + 1];

            if (!ancestorNodeID) return;

            $resourceRelationshipDatastore.createRelationshipBetweenSubjectAndObject(`Node-${nodeID}`, $resourceRelationshipDatastore.membershipPredicateName, (ancestorNodeID === 'SYSTEM') ? 'SYSTEM' : `Node-${ancestorNodeID}`);
          }));
      });

      mocha.teardown(function () {
        Reflect.deleteProperty(this, 'branchNodeIDList');
      });

      mocha.test("The four ancestor of our branch's leaf are retrieved in order of closeness.", async function () {
        const { $datastore, $resourceRelationshipDatastore, branchNodeIDList } = this;

        const ancestorNodeIDList = await NucleusResourceAPI.walkHierarchyTreeUpward.call({ $datastore, $resourceRelationshipDatastore }, `Node-${branchNodeIDList[branchNodeIDList.length - 1]}`);

        chai.expect(ancestorNodeIDList).to.have.length(4);
        chai.expect(ancestorNodeIDList).to.deep.equal(branchNodeIDList.slice(0).reverse().splice(1, branchNodeIDList.length - 2).map(nodeID => ({ ID: nodeID, type: 'Node' })));
      });

      mocha.test.skip("The four children of our branch's knot are retrieved in order of closeness.", async function () {
        const { $datastore, $resourceRelationshipDatastore, branchNodeIDList } = this;

        const childrenNodeIDList = await NucleusResourceAPI.walkHierarchyTreeDownward.call({ $datastore, $resourceRelationshipDatastore }, `Node-${branchNodeIDList[1]}`);

        chai.expect(childrenNodeIDList).to.have.length(4);
        chai.expect(childrenNodeIDList).to.deep.equal(branchNodeIDList.slice(0).splice(2, branchNodeIDList.length - 1).map(nodeID => ({ ID: nodeID, type: 'Node' })));
      });

    });

    mocha.suite("Complex tree", function () {

      mocha.setup(function () {
        const { $datastore } = this;

        return $datastore.$$server.flushallAsync();
      });

      mocha.setup(function () {
        const { $resourceRelationshipDatastore } = this;

        // Given this structure
        //
        // SYSTEM
        //   +
        //   +-> Group <1fb6d396-dd72-4943-9528-06db943d17d8>
        //   |    +
        //   |    +-> User <fcc66afe-3d80-4225-bd1f-7a34bd26f403>
        //   |    |
        //   |    +-> Resource <61fc9214-da8a-4426-8baf-b04565e87d4c>
        //   |    |
        //   |    +-> Group <bebffed5-d356-41d9-a4ed-32d33bba5127>
        //   |         +
        //   |         +-> Resource <0da2e0ec-02a1-4756-89f5-5bf2c2d3664a>
        //   |
        //   +-> Group <6db17cee-2bc8-48b1-901b-048935ba3d23>
        //   |    +
        //   |    +-> Group <cd910f16-6b3d-47cf-8711-8e4add5e8f4f>
        //   |         +
        //   |         +-> Resource <a7dc927f-9ebd-4d3b-8cf5-2ffea24bcf57>
        //   |
        //   +-> Group <caef15f7-58a0-4418-96c2-de211ff2496b>
        //        +
        //        +-> Resource <f76a418a-a4a4-41e8-8f68-99d6b1446bbd>
        //        |
        //        +-> Group <8dcb8309-7ade-4ff4-a6ba-97e5642391c0>
        //             +
        //             +-> User <87330246-ffee-4c87-aa5a-9232bca00132>

        const treeBranchList = [
          [ 'SYSTEM', { type: 'Group', ID: '1fb6d396-dd72-4943-9528-06db943d17d8' }, { type: 'Group', ID: 'bebffed5-d356-41d9-a4ed-32d33bba5127' }, { type: 'Resource', ID: '0da2e0ec-02a1-4756-89f5-5bf2c2d3664a' } ],
          [ 'SYSTEM', { type: 'Group', ID: '1fb6d396-dd72-4943-9528-06db943d17d8' }, { type: 'Resource', ID: '61fc9214-da8a-4426-8baf-b04565e87d4c' } ],
          [ 'SYSTEM', { type: 'Group', ID: '1fb6d396-dd72-4943-9528-06db943d17d8' }, { type: 'User', ID: 'fcc66afe-3d80-4225-bd1f-7a34bd26f403' } ],
          [ 'SYSTEM', { type: 'Group', ID: '6db17cee-2bc8-48b1-901b-048935ba3d23' }, { type: 'Group', ID: 'cd910f16-6b3d-47cf-8711-8e4add5e8f4f' }, { type: 'Resource', ID: 'a7dc927f-9ebd-4d3b-8cf5-2ffea24bcf57' } ],
          [ 'SYSTEM', { type: 'Group', ID: 'caef15f7-58a0-4418-96c2-de211ff2496b' }, { type: 'Group', ID: '8dcb8309-7ade-4ff4-a6ba-97e5642391c0' }, { type: 'User', ID: '87330246-ffee-4c87-aa5a-9232bca00132' } ],
          [ 'SYSTEM', { type: 'Group', ID: 'caef15f7-58a0-4418-96c2-de211ff2496b' }, { type: 'Resource', ID: 'f76a418a-a4a4-41e8-8f68-99d6b1446bbd' } ]
        ];

        Reflect.defineProperty(this, 'treeBranchList', {
          value: treeBranchList,
          writable: false
        });

        return generateHierarchyTree.call({ $resourceRelationshipDatastore }, treeBranchList);
      });

      mocha.teardown(function () {
        Reflect.deleteProperty(this, 'treeBranchList');
      });

      mocha.test("All of the SYSTEM node members are retrieved.", async function () {
        const { $datastore, $resourceRelationshipDatastore } = this;

        const childrenNodeList = await NucleusResourceAPI.walkHierarchyTreeDownward.call({ $datastore, $resourceRelationshipDatastore }, 'SYSTEM');

        chai.expect(childrenNodeList).to.have.length(12);
      });

      mocha.test("The two ancestors of the resource (0da2e0ec-02a1-4756-89f5-5bf2c2d3664a) are retrieved in order of closeness.", async function () {
        const { $datastore, $resourceRelationshipDatastore } = this;

        const ancestorNodeIDList = await NucleusResourceAPI.walkHierarchyTreeUpward.call({ $datastore, $resourceRelationshipDatastore }, 'Resource-0da2e0ec-02a1-4756-89f5-5bf2c2d3664a');

        chai.expect(ancestorNodeIDList).to.have.length(2);
        chai.expect(ancestorNodeIDList).to.deep.equal([ { ID: 'bebffed5-d356-41d9-a4ed-32d33bba5127', type: 'Group' }, { ID: '1fb6d396-dd72-4943-9528-06db943d17d8', type: 'Group' } ]);
      });

      mocha.test("The ancestor of the resource (61fc9214-da8a-4426-8baf-b04565e87d4c) is retrieved.", async function () {
        const { $datastore, $resourceRelationshipDatastore } = this;

        const ancestorNodeIDList = await NucleusResourceAPI.walkHierarchyTreeUpward.call({ $datastore, $resourceRelationshipDatastore }, 'Resource-61fc9214-da8a-4426-8baf-b04565e87d4c');

        chai.expect(ancestorNodeIDList).to.have.length(1);
        chai.expect(ancestorNodeIDList).to.deep.equal([ { ID: '1fb6d396-dd72-4943-9528-06db943d17d8', type: 'Group' } ]);
      });

      mocha.test("The ancestor of the user (fcc66afe-3d80-4225-bd1f-7a34bd26f403) is retrieved.", async function () {
        const { $datastore, $resourceRelationshipDatastore } = this;

        const ancestorNodeIDList = await NucleusResourceAPI.walkHierarchyTreeUpward.call({ $datastore, $resourceRelationshipDatastore }, 'User-fcc66afe-3d80-4225-bd1f-7a34bd26f403');

        chai.expect(ancestorNodeIDList).to.have.length(1);
        chai.expect(ancestorNodeIDList).to.deep.equal([ { ID: '1fb6d396-dd72-4943-9528-06db943d17d8', type: 'Group' } ]);
      });

      mocha.test("The three children of the group (caef15f7-58a0-4418-96c2-de211ff2496b) are retrieved in order of closeness.", async function () {
        const { $datastore, $resourceRelationshipDatastore } = this;

        const childrenNodeIDList = await NucleusResourceAPI.walkHierarchyTreeDownward.call({ $datastore, $resourceRelationshipDatastore }, 'Group-caef15f7-58a0-4418-96c2-de211ff2496b');

        chai.expect(childrenNodeIDList).to.have.length(3);
        chai.expect(childrenNodeIDList).to.deep.members([ { ID: '8dcb8309-7ade-4ff4-a6ba-97e5642391c0', type: 'Group' }, { ID: 'f76a418a-a4a4-41e8-8f68-99d6b1446bbd', type: 'Resource' }, { ID: '87330246-ffee-4c87-aa5a-9232bca00132', type: 'User' }]);
      });

      mocha.test("The user (fcc66afe-3d80-4225-bd1f-7a34bd26f403) can retrieve the resource (61fc9214-da8a-4426-8baf-b04565e87d4c).", async function () {
        const { $datastore, $resourceRelationshipDatastore } = this;

        const { canRetrieveResource } = await NucleusResourceAPI.verifyThatUserCanRetrieveResource.call({ $datastore, $resourceRelationshipDatastore }, 'fcc66afe-3d80-4225-bd1f-7a34bd26f403', 'Resource', '61fc9214-da8a-4426-8baf-b04565e87d4c');

        chai.expect(canRetrieveResource).to.be.true;
      });

      mocha.test("The user (fcc66afe-3d80-4225-bd1f-7a34bd26f403) can retrieve the resource (0da2e0ec-02a1-4756-89f5-5bf2c2d3664a).", async function () {
        const { $datastore, $resourceRelationshipDatastore } = this;

        const { canRetrieveResource } = await NucleusResourceAPI.verifyThatUserCanRetrieveResource.call({ $datastore, $resourceRelationshipDatastore }, 'fcc66afe-3d80-4225-bd1f-7a34bd26f403', 'Resource', '0da2e0ec-02a1-4756-89f5-5bf2c2d3664a');

        chai.expect(canRetrieveResource).to.be.true;
      });

      mocha.test("The user (fcc66afe-3d80-4225-bd1f-7a34bd26f403) can not retrieve the resource (a7dc927f-9ebd-4d3b-8cf5-2ffea24bcf57).", async function () {
        const { $datastore, $resourceRelationshipDatastore } = this;

        const { canRetrieveResource } = await NucleusResourceAPI.verifyThatUserCanRetrieveResource.call({ $datastore, $resourceRelationshipDatastore }, 'fcc66afe-3d80-4225-bd1f-7a34bd26f403', 'Resource', 'a7dc927f-9ebd-4d3b-8cf5-2ffea24bcf57');

        chai.expect(canRetrieveResource).to.be.false;
      });

      mocha.test("The user (fcc66afe-3d80-4225-bd1f-7a34bd26f403) can update the resource (61fc9214-da8a-4426-8baf-b04565e87d4c).", async function () {
        const { $datastore, $resourceRelationshipDatastore } = this;

        const { canUpdateResource } = await NucleusResourceAPI.verifyThatUserCanUpdateResource.call({ $datastore, $resourceRelationshipDatastore }, 'fcc66afe-3d80-4225-bd1f-7a34bd26f403', 'Resource', '61fc9214-da8a-4426-8baf-b04565e87d4c');

        chai.expect(canUpdateResource).to.be.true;
      });

      mocha.test("The user (fcc66afe-3d80-4225-bd1f-7a34bd26f403) can update the resource (0da2e0ec-02a1-4756-89f5-5bf2c2d3664a).", async function () {
        const { $datastore, $resourceRelationshipDatastore } = this;

        const { canUpdateResource } = await NucleusResourceAPI.verifyThatUserCanUpdateResource.call({ $datastore, $resourceRelationshipDatastore }, 'fcc66afe-3d80-4225-bd1f-7a34bd26f403', 'Resource', '0da2e0ec-02a1-4756-89f5-5bf2c2d3664a');

        chai.expect(canUpdateResource).to.be.true;
      });

      mocha.test("The user (fcc66afe-3d80-4225-bd1f-7a34bd26f403) can not update the resource (a7dc927f-9ebd-4d3b-8cf5-2ffea24bcf57).", async function () {
        const { $datastore, $resourceRelationshipDatastore } = this;

        const { canUpdateResource } = await NucleusResourceAPI.verifyThatUserCanUpdateResource.call({ $datastore, $resourceRelationshipDatastore }, 'fcc66afe-3d80-4225-bd1f-7a34bd26f403', 'Resource', 'a7dc927f-9ebd-4d3b-8cf5-2ffea24bcf57');

        chai.expect(canUpdateResource).to.be.false;
      });

      mocha.test("The user (87330246-ffee-4c87-aa5a-9232bca00132) can not update the resource (f76a418a-a4a4-41e8-8f68-99d6b1446bbd).", async function () {
        const { $datastore, $resourceRelationshipDatastore } = this;

        const { canUpdateResource } = await NucleusResourceAPI.verifyThatUserCanUpdateResource.call({ $datastore, $resourceRelationshipDatastore }, '87330246-ffee-4c87-aa5a-9232bca00132', 'Resource', 'f76a418a-a4a4-41e8-8f68-99d6b1446bbd');

        chai.expect(canUpdateResource).to.be.false;
      });

    });

  });

  mocha.suite("Persistent storage", function () {
    const resourceType = 'Dummy';

    class DummyResourceModel extends NucleusResource {

      constructor (resourceAttributes, authorUserID, reservedID) {
        super('Dummy', { name: 'string' }, resourceAttributes, authorUserID, reservedID);
      }
    }

    mocha.setup(function () {
      const { $datastore } = this;

      return $datastore.$$server.flushallAsync();
    });

    mocha.setup(function () {
      const { $datastore, $resourceRelationshipDatastore } = this;

      // Given this structure
      //
      // SYSTEM
      // +
      // +-> Group <282c1b2c-0cd4-454f-bf8f-52b450e7aee5>
      // |    +
      // |    +-> User <e11918ea-2bd4-4d8f-bf90-2c431076e23c>
      // |    |
      // |    +-> Group <69b8a1da-95e1-4f20-8529-c03ba9bc7807>
      // |
      // +-> Group <e619b5e2-2737-42fa-aa13-f75740270107>
      // |
      // +-> Group <61b27ed4-4b79-4b47-87c6-35440e2cc62a>
      // |    +
      // |    +-> Group <4648d7c6-0d2e-461c-a0ed-cbdb76d41a87>
      // |    +
      // |    +-> User <1c76c8d1-8cdc-4c40-8132-36f657b5bf69>
      // |
      // +-> User <3e0d8bbc-3ffe-4f09-a276-a8e61495ec22>


      const treeBranchList = [
        [ 'SYSTEM', { type: 'Group', ID: '282c1b2c-0cd4-454f-bf8f-52b450e7aee5' }, { type: 'User', ID: 'e11918ea-2bd4-4d8f-bf90-2c431076e23c' } ],
        [ 'SYSTEM', { type: 'Group', ID: '282c1b2c-0cd4-454f-bf8f-52b450e7aee5' }, { type: 'Group', ID: '69b8a1da-95e1-4f20-8529-c03ba9bc7807' } ],
        [ 'SYSTEM', { type: 'Group', ID: 'e619b5e2-2737-42fa-aa13-f75740270107' } ],
        [ 'SYSTEM', { type: 'Group', ID: '61b27ed4-4b79-4b47-87c6-35440e2cc62a' }, { type: 'Group', ID: '4648d7c6-0d2e-461c-a0ed-cbdb76d41a87' } ],
        [ 'SYSTEM', { type: 'Group', ID: '61b27ed4-4b79-4b47-87c6-35440e2cc62a' }, { type: 'User', ID: '1c76c8d1-8cdc-4c40-8132-36f657b5bf69' } ],
        [ 'SYSTEM', { type: 'User', ID: '3e0d8bbc-3ffe-4f09-a276-a8e61495ec22' } ]
      ];

      Reflect.defineProperty(this, 'treeBranchList', {
        value: treeBranchList,
        writable: false
      });

      return generateHierarchyTree.call({ $resourceRelationshipDatastore }, treeBranchList);
    });

    mocha.teardown(function () {
      Reflect.deleteProperty(this, 'treeBranchList');
    });

    mocha.teardown(function () {
      const { $datastore, $resourceRelationshipDatastore } = this;

      // Automatically restore any method that could have been wrapped as Spy.
      [
        $datastore,
        $resourceRelationshipDatastore
      ]
        .forEach($store => {

          Object.keys($store)
            .filter((key) => {
              if (key === 'name' || key === 'index') return false;
              if (/^\$+.+/.test(key)) return false;
              else return true;
            })
            .forEach((key) => {
              const { value } = Reflect.getOwnPropertyDescriptor($store, key);

              if (value instanceof Function && 'restore' in value) value.restore();
            });
        });
    });

    mocha.suite("#createResource", function () {

      mocha.test("The dummy resource is created in the datastore.", function () {
        const { $datastore, $resourceRelationshipDatastore, $$sandbox } = this;
        const $$datastoreAddItemToHashFieldByNameSpy = $$sandbox.spy($datastore, 'addItemToHashFieldByName');

        const dummyAttributes = {
          name: `Dummy ${uuid.v4()}`
        };
        const authorUserID = 'e11918ea-2bd4-4d8f-bf90-2c431076e23c';
        const groupID = '282c1b2c-0cd4-454f-bf8f-52b450e7aee5';

        return NucleusResourceAPI.createResource.call({ $datastore, $resourceRelationshipDatastore }, resourceType, DummyResourceModel, dummyAttributes, authorUserID, 'Group', groupID)
          .then(() => {
            chai.expect($$datastoreAddItemToHashFieldByNameSpy.calledOnceWith(
              sinon.match(/Dummy:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/),
              sinon.match({
                ID: sinon.match(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/),
                meta: sinon.match.object,
                name: dummyAttributes.name,
                type: resourceType
              })
            )).to.be.true;
          });
      });

      mocha.test("The dummy resource's relationship with its author and its group is created.", function () {
        const { $datastore, $resourceRelationshipDatastore, $$sandbox } = this;
        const $$resourceRelationshipDatastoreCreateRelationshipBetweenSubjectAndObject = $$sandbox.spy($resourceRelationshipDatastore, 'createRelationshipBetweenSubjectAndObject');

        const dummyAttributes = {
          name: `Dummy ${uuid.v4()}`
        };
        const authorUserID = 'e11918ea-2bd4-4d8f-bf90-2c431076e23c';
        const groupID = '69b8a1da-95e1-4f20-8529-c03ba9bc7807';

        return NucleusResourceAPI.createResource.call({ $datastore, $resourceRelationshipDatastore }, resourceType, DummyResourceModel, dummyAttributes, authorUserID, 'Group', groupID)
          .then(() => {
            chai.expect($$resourceRelationshipDatastoreCreateRelationshipBetweenSubjectAndObject.calledTwice).to.be.true;
            chai.expect($$resourceRelationshipDatastoreCreateRelationshipBetweenSubjectAndObject.calledWith(
              sinon.match($$nodeTypeNodeIDRegularExpression),
              $resourceRelationshipDatastore.membershipPredicateName,
              `Group-${groupID}`
            )).to.be.true;
            chai.expect($$resourceRelationshipDatastoreCreateRelationshipBetweenSubjectAndObject.calledWith(
              sinon.match($$nodeTypeNodeIDRegularExpression),
              $resourceRelationshipDatastore.authorshipPredicateName,
              `User-${authorUserID}`
            )).to.be.true;
          });
      });

      mocha.test("The dummy resource can be created without a resource relationship datastore.", function () {
        const { $datastore, $resourceRelationshipDatastore, $$sandbox } = this;
        const $$resourceRelationshipDatastoreCreateRelationshipBetweenSubjectAndObject = $$sandbox.spy($resourceRelationshipDatastore, 'createRelationshipBetweenSubjectAndObject');

        const dummyAttributes = {
          name: `Dummy ${uuid.v4()}`
        };
        const authorUserID = 'e11918ea-2bd4-4d8f-bf90-2c431076e23c';
        const groupID = '282c1b2c-0cd4-454f-bf8f-52b450e7aee5';

        return NucleusResourceAPI.createResource.call({ $datastore }, resourceType, DummyResourceModel, dummyAttributes, authorUserID, 'Group', groupID)
          .then(() => {
            chai.expect($$resourceRelationshipDatastoreCreateRelationshipBetweenSubjectAndObject.notCalled).to.be.true;
          });
      });

      mocha.test("The formatted resource, the resource's author and the resource's group is returned.", function () {
        const { $datastore, $resourceRelationshipDatastore } = this;

        const dummyAttributes = {
          name: `Dummy ${uuid.v4()}`
        };
        const authorUserID = 'e11918ea-2bd4-4d8f-bf90-2c431076e23c';
        const groupID = '282c1b2c-0cd4-454f-bf8f-52b450e7aee5';

        return NucleusResourceAPI.createResource.call({ $datastore, $resourceRelationshipDatastore }, resourceType, DummyResourceModel, dummyAttributes, authorUserID, 'Group', groupID)
          .then(({ resource, resourceRelationships }) => {
            chai.expect(resource).to.be.an.instanceOf(NucleusResource);
            chai.expect(resource).to.deep.include(dummyAttributes);
            chai.expect(resourceRelationships[$resourceRelationshipDatastore.authorshipPredicateName][0].resourceID).to.equal(authorUserID);
            chai.expect(resourceRelationships[$resourceRelationshipDatastore.membershipPredicateName][0].resourceID).to.equal(groupID);
          });
      });

      mocha.test.skip("The dummy resource is created by default in the group of the author user.", function () {
        const { $datastore, $resourceRelationshipDatastore } = this;

        const dummyAttributes = {
          name: `Dummy ${uuid.v4()}`
        };
        const authorUserID = 'e11918ea-2bd4-4d8f-bf90-2c431076e23c';

        return chai.expect(NucleusResourceAPI.createResource.call({ $datastore, $resourceRelationshipDatastore }, resourceType, DummyResourceModel, dummyAttributes, authorUserID))
          .to.eventually.deep.property({
            resourceRelationships: {
              [$resourceRelationshipDatastore.membershipPredicateName]: [
                {
                  relationship: $resourceRelationshipDatastore.membershipPredicateName,
                  resourceID: '282c1b2c-0cd4-454f-bf8f-52b450e7aee5'
                }
              ]
            }
           });
      });

      mocha.test.skip("The resource can reserve its own ID.", function () {
        const { $datastore, $resourceRelationshipDatastore } = this;

        const dummyAttributes = {
          ID: uuid.v4(),
          name: `Dummy ${uuid.v4()}`
        };
        const authorUserID = 'e11918ea-2bd4-4d8f-bf90-2c431076e23c';

        return chai.expect(NucleusResourceAPI.createResource.call({ $datastore, $resourceRelationshipDatastore }, resourceType, DummyResourceModel, dummyAttributes, authorUserID))
          .to.eventually.deep.include({ resource: { ID: dummyAttributes.ID } });
      });

      mocha.test("Using resource attributes that doesn't validate against the resource model throws an error.", function () {
        const { $datastore, $resourceRelationshipDatastore } = this;

        const dummyAttributes = {
          name: 9000
        };
        const authorUserID = 'e11918ea-2bd4-4d8f-bf90-2c431076e23c';

        return chai.expect(NucleusResourceAPI.createResource.call({ $datastore, $resourceRelationshipDatastore }, resourceType, DummyResourceModel, dummyAttributes, authorUserID))
          .to.be.rejectedWith(NucleusError, /.*Expected a value of type `string` for `name` but received `9000`.*/);
      });

      mocha.test("Using an undefined resource type throws an error.", function () {
        const { $datastore, $resourceRelationshipDatastore } = this;

        const dummyAttributes = {
          name: `Dummy ${uuid.v4()}`
        };
        const authorUserID = 'e11918ea-2bd4-4d8f-bf90-2c431076e23c';

        return chai.expect(NucleusResourceAPI.createResource.call({ $datastore, $resourceRelationshipDatastore }, undefined, DummyResourceModel, dummyAttributes, authorUserID))
          .to.be.rejectedWith(NucleusError.UnexpectedValueTypeNucleusError);
      });

      mocha.test("Using an undefined resource model throws an error.", function () {
        const { $datastore, $resourceRelationshipDatastore } = this;

        const dummyAttributes = {
          name: `Dummy ${uuid.v4()}`
        };
        const authorUserID = 'e11918ea-2bd4-4d8f-bf90-2c431076e23c';

        return chai.expect(NucleusResourceAPI.createResource.call({ $datastore, $resourceRelationshipDatastore }, resourceType, undefined, dummyAttributes, authorUserID))
          .to.be.rejectedWith(NucleusError.UnexpectedValueTypeNucleusError);
      });

      mocha.test("Using a non-existing user throws an error.", function () {
        const { $datastore, $resourceRelationshipDatastore } = this;

        const dummyAttributes = {
          name: `Dummy ${uuid.v4()}`
        };
        const authorUserID = uuid.v4();

        return chai.expect(NucleusResourceAPI.createResource.call({ $datastore, $resourceRelationshipDatastore }, resourceType, DummyResourceModel, dummyAttributes, authorUserID))
          .to.be.rejectedWith(NucleusError);
      });

    });

    mocha.suite("#removeResourceByID", function () {

      mocha.test("The dummy resource is removed from the datastore.", async function () {
        const { $datastore, $resourceRelationshipDatastore, $$sandbox } = this;
        const $$datastoreRemoveItemByNameSpy = $$sandbox.spy($datastore, 'removeItemByName');

        const dummyAttributes = {
          name: `Dummy ${uuid.v4()}`
        };
        const authorUserID = 'e11918ea-2bd4-4d8f-bf90-2c431076e23c';
        const groupID = '282c1b2c-0cd4-454f-bf8f-52b450e7aee5';

        const { resource: { ID: resourceID } } = await NucleusResourceAPI.createResource.call({ $datastore, $resourceRelationshipDatastore }, resourceType, DummyResourceModel, dummyAttributes, authorUserID, 'Group', groupID);

        return NucleusResourceAPI.removeResourceByID.call({ $datastore, $resourceRelationshipDatastore }, resourceType, resourceID, authorUserID)
          .then(() => {
            chai.expect($$datastoreRemoveItemByNameSpy.calledOnceWith(
              NucleusResource.generateItemKey(resourceType, resourceID)
            )).to.be.true;
          });
      });

      mocha.test("The dummy resource relationships are removed from the resource relationship datastore.", async function () {
        const { $datastore, $resourceRelationshipDatastore, $$sandbox } = this;
        const $$resourceRelationshipDatastoreRemoveAllRelationshipsToVectorSpy = $$sandbox.spy($resourceRelationshipDatastore, 'removeAllRelationshipsToVector');

        const dummyAttributes = {
          name: `Dummy ${uuid.v4()}`
        };
        const authorUserID = 'e11918ea-2bd4-4d8f-bf90-2c431076e23c';
        const groupID = '282c1b2c-0cd4-454f-bf8f-52b450e7aee5';

        const { resource: { ID: resourceID } } = await NucleusResourceAPI.createResource.call({ $datastore, $resourceRelationshipDatastore }, resourceType, DummyResourceModel, dummyAttributes, authorUserID, 'Group', groupID);

        return NucleusResourceAPI.removeResourceByID.call({ $datastore, $resourceRelationshipDatastore }, resourceType, resourceID, authorUserID)
          .then(() => {
            chai.expect($$resourceRelationshipDatastoreRemoveAllRelationshipsToVectorSpy.calledWith({
              ID: resourceID,
              type: resourceType
            })).to.be.true;
          });
      });

      mocha.test("The dummy resource can't be removed by a user from another branch.", async function () {
        const { $datastore, $resourceRelationshipDatastore } = this;

        const dummyAttributes = {
          name: `Dummy ${uuid.v4()}`
        };
        const authorUserID = 'e11918ea-2bd4-4d8f-bf90-2c431076e23c';
        const groupID = '282c1b2c-0cd4-454f-bf8f-52b450e7aee5';

        const { resource: { ID: resourceID } } = await NucleusResourceAPI.createResource.call({ $datastore, $resourceRelationshipDatastore }, resourceType, DummyResourceModel, dummyAttributes, authorUserID, 'Group', groupID);

        const originUserID = '1c76c8d1-8cdc-4c40-8132-36f657b5bf69';

        chai.expect(NucleusResourceAPI.removeResourceByID.call({ $datastore, $resourceRelationshipDatastore }, resourceType, resourceID, originUserID))
          .to.be.rejectedWith(NucleusError.UnauthorizedActionNucleusError);
      });

    });

    mocha.suite("#retrieveResourceByID", function () {

      mocha.test("The dummy resource is retrieved from the datastore.", async function () {
        const { $datastore, $resourceRelationshipDatastore, $$sandbox } = this;
        const $$datastoreRetrieveAllItemsFromHashByNameSpy = $$sandbox.spy($datastore, 'retrieveAllItemsFromHashByName');

        const dummyAttributes = {
          name: `Dummy ${uuid.v4()}`
        };
        const authorUserID = 'e11918ea-2bd4-4d8f-bf90-2c431076e23c';
        const groupID = '282c1b2c-0cd4-454f-bf8f-52b450e7aee5';

        const { resource: { ID: resourceID } } = await NucleusResourceAPI.createResource.call({ $datastore, $resourceRelationshipDatastore }, resourceType, DummyResourceModel, dummyAttributes, authorUserID, 'Group', groupID);

        return NucleusResourceAPI.retrieveResourceByID.call({ $datastore, $resourceRelationshipDatastore }, resourceType, DummyResourceModel, resourceID, authorUserID)
          .then(() => {
            chai.expect($$datastoreRetrieveAllItemsFromHashByNameSpy.calledOnceWith(
              NucleusResource.generateItemKey(resourceType, resourceID)
            )).to.be.true;
          });
      });

      mocha.test("The dummy resource can't be retrieve by a user from another branch.", async function () {
        const { $datastore, $resourceRelationshipDatastore } = this;

        const dummyAttributes = {
          name: `Dummy ${uuid.v4()}`
        };
        const authorUserID = 'e11918ea-2bd4-4d8f-bf90-2c431076e23c';
        const groupID = '282c1b2c-0cd4-454f-bf8f-52b450e7aee5';

        const { resource: { ID: resourceID } } = await NucleusResourceAPI.createResource.call({ $datastore, $resourceRelationshipDatastore }, resourceType, DummyResourceModel, dummyAttributes, authorUserID, 'Group', groupID);

        const originUserID = '1c76c8d1-8cdc-4c40-8132-36f657b5bf69';

        chai.expect(NucleusResourceAPI.retrieveResourceByID.call({ $datastore, $resourceRelationshipDatastore }, resourceType, DummyResourceModel, resourceID, originUserID))
          .to.be.rejectedWith(NucleusError.UnauthorizedActionNucleusError);
      });

    });

    mocha.suite("#retrieveAllNodesByType", function () {

      mocha.setup(function () {
        const { $datastore, $resourceRelationshipDatastore } = this;

        // Creating 4 dummies, in 3 different groups by 2 different users.
        return Promise.all([
          NucleusResourceAPI.createResource.call({ $datastore, $resourceRelationshipDatastore }, resourceType, DummyResourceModel, { ID: '22d969f8-ef02-4e31-ae5f-24f9e864a390', name: 'Dummy 22d969f8-ef02-4e31-ae5f-24f9e864a390' }, 'e11918ea-2bd4-4d8f-bf90-2c431076e23c', 'Group', '282c1b2c-0cd4-454f-bf8f-52b450e7aee5'),
          NucleusResourceAPI.createResource.call({ $datastore, $resourceRelationshipDatastore }, resourceType, DummyResourceModel, { ID: 'b1947406-cdad-4c5c-9c44-8a544221b318', name: 'Dummy b1947406-cdad-4c5c-9c44-8a544221b318' }, 'e11918ea-2bd4-4d8f-bf90-2c431076e23c', 'Group', '282c1b2c-0cd4-454f-bf8f-52b450e7aee5'),
          NucleusResourceAPI.createResource.call({ $datastore, $resourceRelationshipDatastore }, resourceType, DummyResourceModel, { ID: '84247275-311c-4858-9dab-f94c655e2b34', name: 'Dummy 84247275-311c-4858-9dab-f94c655e2b34' }, '1c76c8d1-8cdc-4c40-8132-36f657b5bf69', 'Group', '4648d7c6-0d2e-461c-a0ed-cbdb76d41a87'),
          NucleusResourceAPI.createResource.call({ $datastore, $resourceRelationshipDatastore }, resourceType, DummyResourceModel, { ID: '0b585001-5262-4a53-9007-d5cbc287f8ee', name: 'Dummy 0b585001-5262-4a53-9007-d5cbc287f8ee' }, '1c76c8d1-8cdc-4c40-8132-36f657b5bf69', 'Group', '61b27ed4-4b79-4b47-87c6-35440e2cc62a'),
        ]);
      });

      mocha.test("The nodes are retrieved based on the user ID hierarchical position.", function () {
        const { $datastore, $resourceRelationshipDatastore } = this;

        const originUserID = 'e11918ea-2bd4-4d8f-bf90-2c431076e23c';

        return NucleusResourceAPI.retrieveAllNodesByType.call({ $datastore, $resourceRelationshipDatastore }, 'Dummy', originUserID)
          .then((resourceList) => {
            // The user retrieve 2 dummies and 1 user, itself as part of the group.
            chai.expect(resourceList).to.have.length(2);
            chai.expect(resourceList).to.deep.equal([
              {
                ID: '22d969f8-ef02-4e31-ae5f-24f9e864a390',
                type: 'Dummy'
              },
              {
                ID: 'b1947406-cdad-4c5c-9c44-8a544221b318',
                type: 'Dummy'
              }
            ]);
          });
      });

    });

    mocha.suite("#retrieveAllNodesByRelationshipWithNodeByID", function () {

      mocha.setup(function () {
        const { $datastore, $resourceRelationshipDatastore } = this;

        // Creating 4 dummies, in 3 different groups by 2 different users.
        return Promise.all([
          NucleusResourceAPI.createResource.call({ $datastore, $resourceRelationshipDatastore }, resourceType, DummyResourceModel, { ID: '22d969f8-ef02-4e31-ae5f-24f9e864a390', name: 'Dummy 22d969f8-ef02-4e31-ae5f-24f9e864a390' }, 'e11918ea-2bd4-4d8f-bf90-2c431076e23c', 'Group', '282c1b2c-0cd4-454f-bf8f-52b450e7aee5'),
          NucleusResourceAPI.createResource.call({ $datastore, $resourceRelationshipDatastore }, resourceType, DummyResourceModel, { ID: 'b1947406-cdad-4c5c-9c44-8a544221b318', name: 'Dummy b1947406-cdad-4c5c-9c44-8a544221b318' }, 'e11918ea-2bd4-4d8f-bf90-2c431076e23c', 'Group', '282c1b2c-0cd4-454f-bf8f-52b450e7aee5'),
          NucleusResourceAPI.createResource.call({ $datastore, $resourceRelationshipDatastore }, resourceType, DummyResourceModel, { ID: '84247275-311c-4858-9dab-f94c655e2b34', name: 'Dummy 84247275-311c-4858-9dab-f94c655e2b34' }, '1c76c8d1-8cdc-4c40-8132-36f657b5bf69', 'Group', '4648d7c6-0d2e-461c-a0ed-cbdb76d41a87'),
          NucleusResourceAPI.createResource.call({ $datastore, $resourceRelationshipDatastore }, resourceType, DummyResourceModel, { ID: '0b585001-5262-4a53-9007-d5cbc287f8ee', name: 'Dummy 0b585001-5262-4a53-9007-d5cbc287f8ee' }, '1c76c8d1-8cdc-4c40-8132-36f657b5bf69', 'Group', '61b27ed4-4b79-4b47-87c6-35440e2cc62a')
        ]);
      });

      mocha.test("All the members of the node are retrieved.", function () {
        const { $datastore, $resourceRelationshipDatastore } = this;

        const originUserID = 'e11918ea-2bd4-4d8f-bf90-2c431076e23c';
        const nodeID = '282c1b2c-0cd4-454f-bf8f-52b450e7aee5';

        return NucleusResourceAPI.retrieveAllNodesByRelationshipWithNodeByID.call({ $datastore, $resourceRelationshipDatastore }, 'Group', nodeID, $resourceRelationshipDatastore.membershipPredicateName, originUserID)
          .then((resourceList) => {
            // The user retrieve 2 dummies and 1 user, itself as part of the group.
            chai.expect(resourceList).to.have.length(4);
            chai.expect(resourceList).to.deep.equal([
              {
                ID: '22d969f8-ef02-4e31-ae5f-24f9e864a390',
                type: 'Dummy'
              },
              {
                ID: 'b1947406-cdad-4c5c-9c44-8a544221b318',
                type: 'Dummy'
              },
              {
                ID: '69b8a1da-95e1-4f20-8529-c03ba9bc7807',
                type: 'Group'
              },
              {
                ID: originUserID,
                type: 'User'
              }
            ]);
          });
      });

    });

    mocha.suite("#retrieveAllResourcesByType", function () {

      mocha.setup(function () {
        const { $datastore, $resourceRelationshipDatastore } = this;

        // Creating 4 dummies, in 3 different groups by 2 different users.
        return Promise.all([
          NucleusResourceAPI.createResource.call({ $datastore, $resourceRelationshipDatastore }, resourceType, DummyResourceModel, { ID: '22d969f8-ef02-4e31-ae5f-24f9e864a390', name: 'Dummy 22d969f8-ef02-4e31-ae5f-24f9e864a390' }, 'e11918ea-2bd4-4d8f-bf90-2c431076e23c', 'Group', '282c1b2c-0cd4-454f-bf8f-52b450e7aee5'),
          NucleusResourceAPI.createResource.call({ $datastore, $resourceRelationshipDatastore }, resourceType, DummyResourceModel, { ID: 'b1947406-cdad-4c5c-9c44-8a544221b318', name: 'Dummy b1947406-cdad-4c5c-9c44-8a544221b318' }, 'e11918ea-2bd4-4d8f-bf90-2c431076e23c', 'Group', '282c1b2c-0cd4-454f-bf8f-52b450e7aee5'),
          NucleusResourceAPI.createResource.call({ $datastore, $resourceRelationshipDatastore }, resourceType, DummyResourceModel, { ID: '84247275-311c-4858-9dab-f94c655e2b34', name: 'Dummy 84247275-311c-4858-9dab-f94c655e2b34' }, '1c76c8d1-8cdc-4c40-8132-36f657b5bf69', 'Group', '4648d7c6-0d2e-461c-a0ed-cbdb76d41a87'),
          NucleusResourceAPI.createResource.call({ $datastore, $resourceRelationshipDatastore }, resourceType, DummyResourceModel, { ID: '0b585001-5262-4a53-9007-d5cbc287f8ee', name: 'Dummy 0b585001-5262-4a53-9007-d5cbc287f8ee' }, '1c76c8d1-8cdc-4c40-8132-36f657b5bf69', 'Group', '61b27ed4-4b79-4b47-87c6-35440e2cc62a')
        ]);
      });

      mocha.test("All the dummy resources are retrieved.", function () {
        const { $datastore, $resourceRelationshipDatastore } = this;

        const originUserID = 'e11918ea-2bd4-4d8f-bf90-2c431076e23c';

        return NucleusResourceAPI.retrieveAllResourcesByType.call({ $datastore, $resourceRelationshipDatastore }, 'Dummy', DummyResourceModel, originUserID)
          .then(({ resourceList }) => {
            // The user retrieve 2 dummies.
            chai.expect(resourceList).to.have.length(2);
            chai.expect(resourceList).to.have.nested.property('[0].resource.ID', '22d969f8-ef02-4e31-ae5f-24f9e864a390');
            chai.expect(resourceList).to.have.nested.property('[0].resource.type', 'Dummy');
            chai.expect(resourceList).to.have.nested.property(`[0].resourceRelationships.${$resourceRelationshipDatastore.authorshipPredicateName}[0].resourceID`, 'e11918ea-2bd4-4d8f-bf90-2c431076e23c');
            chai.expect(resourceList).to.have.nested.property(`[0].resourceRelationships.${$resourceRelationshipDatastore.membershipPredicateName}[0].resourceID`, '282c1b2c-0cd4-454f-bf8f-52b450e7aee5');
            chai.expect(resourceList).to.have.nested.property('[1].resource.ID', 'b1947406-cdad-4c5c-9c44-8a544221b318');
            chai.expect(resourceList).to.have.nested.property('[1].resource.type', 'Dummy');
            chai.expect(resourceList).to.have.nested.property(`[1].resourceRelationships.${$resourceRelationshipDatastore.authorshipPredicateName}[0].resourceID`, 'e11918ea-2bd4-4d8f-bf90-2c431076e23c');
            chai.expect(resourceList).to.have.nested.property(`[1].resourceRelationships.${$resourceRelationshipDatastore.membershipPredicateName}[0].resourceID`, '282c1b2c-0cd4-454f-bf8f-52b450e7aee5');
          });
      });

    });

    mocha.suite("#retrieveAllResourcesByTypeForResourceByID", function () {

      mocha.setup(function () {
        const { $datastore, $resourceRelationshipDatastore } = this;

        // Creating 6 dummies, in 3 different groups by 2 different users.
        return Promise.all([
          NucleusResourceAPI.createResource.call({ $datastore, $resourceRelationshipDatastore }, resourceType, DummyResourceModel, { ID: '22d969f8-ef02-4e31-ae5f-24f9e864a390', name: 'Dummy 22d969f8-ef02-4e31-ae5f-24f9e864a390' }, 'e11918ea-2bd4-4d8f-bf90-2c431076e23c', 'Group', '282c1b2c-0cd4-454f-bf8f-52b450e7aee5'),
          NucleusResourceAPI.createResource.call({ $datastore, $resourceRelationshipDatastore }, resourceType, DummyResourceModel, { ID: 'b1947406-cdad-4c5c-9c44-8a544221b318', name: 'Dummy b1947406-cdad-4c5c-9c44-8a544221b318' }, 'e11918ea-2bd4-4d8f-bf90-2c431076e23c', 'Group', '282c1b2c-0cd4-454f-bf8f-52b450e7aee5'),
          NucleusResourceAPI.createResource.call({ $datastore, $resourceRelationshipDatastore }, resourceType, DummyResourceModel, { ID: '88c1c8fc-c029-49fe-9ac2-7b572f98e646', name: 'Dummy 88c1c8fc-c029-49fe-9ac2-7b572f98e646' }, 'e11918ea-2bd4-4d8f-bf90-2c431076e23c', 'Group', '69b8a1da-95e1-4f20-8529-c03ba9bc7807'),
          NucleusResourceAPI.createResource.call({ $datastore, $resourceRelationshipDatastore }, resourceType, DummyResourceModel, { ID: 'a96b075a-172a-45fe-af23-6cb3e5038573', name: 'Dummy a96b075a-172a-45fe-af23-6cb3e5038573' }, 'e11918ea-2bd4-4d8f-bf90-2c431076e23c', 'Group', '69b8a1da-95e1-4f20-8529-c03ba9bc7807'),
          NucleusResourceAPI.createResource.call({ $datastore, $resourceRelationshipDatastore }, resourceType, DummyResourceModel, { ID: '84247275-311c-4858-9dab-f94c655e2b34', name: 'Dummy 84247275-311c-4858-9dab-f94c655e2b34' }, '1c76c8d1-8cdc-4c40-8132-36f657b5bf69', 'Group', '4648d7c6-0d2e-461c-a0ed-cbdb76d41a87'),
          NucleusResourceAPI.createResource.call({ $datastore, $resourceRelationshipDatastore }, resourceType, DummyResourceModel, { ID: '0b585001-5262-4a53-9007-d5cbc287f8ee', name: 'Dummy 0b585001-5262-4a53-9007-d5cbc287f8ee' }, '1c76c8d1-8cdc-4c40-8132-36f657b5bf69', 'Group', '61b27ed4-4b79-4b47-87c6-35440e2cc62a')
        ]);
      });

      mocha.test("All the dummy resources for the group are retrieved.", function () {
        const { $datastore, $resourceRelationshipDatastore } = this;

        const groupID = '69b8a1da-95e1-4f20-8529-c03ba9bc7807';
        const originUserID = 'e11918ea-2bd4-4d8f-bf90-2c431076e23c';

        // 69b8a1da-95e1-4f20-8529-c03ba9bc7807 Group Dummy Permission: 24.791ms
        // 69b8a1da-95e1-4f20-8529-c03ba9bc7807 Group Dummy Node: 5.853ms
        // 69b8a1da-95e1-4f20-8529-c03ba9bc7807 Group Dummy Resource: 4.138ms

        return NucleusResourceAPI.retrieveAllResourcesByTypeForResourceByID.call({ $datastore, $resourceRelationshipDatastore }, 'Group', groupID, 'Dummy', DummyResourceModel, originUserID)
          .then(({ resourceList }) => {
            // The user retrieve 2 dummies.
            chai.expect(resourceList).to.have.length(2);
            chai.expect(resourceList).to.have.nested.property('[0].resource.ID', '88c1c8fc-c029-49fe-9ac2-7b572f98e646');
            chai.expect(resourceList).to.have.nested.property('[0].resource.type', 'Dummy');
            chai.expect(resourceList).to.have.nested.property('[1].resource.ID', 'a96b075a-172a-45fe-af23-6cb3e5038573');
            chai.expect(resourceList).to.have.nested.property('[1].resource.type', 'Dummy');
          });
      });

    });

    mocha.suite("#retrieveBatchResourceByIDList", function () {

      mocha.setup(function () {
        const { $datastore, $resourceRelationshipDatastore } = this;

        // Creating 4 dummies, in 3 different groups by 2 different users.
        return Promise.all([
          NucleusResourceAPI.createResource.call({ $datastore, $resourceRelationshipDatastore }, resourceType, DummyResourceModel, { ID: '22d969f8-ef02-4e31-ae5f-24f9e864a390', name: 'Dummy 22d969f8-ef02-4e31-ae5f-24f9e864a390' }, 'e11918ea-2bd4-4d8f-bf90-2c431076e23c', 'Group', '282c1b2c-0cd4-454f-bf8f-52b450e7aee5'),
          NucleusResourceAPI.createResource.call({ $datastore, $resourceRelationshipDatastore }, resourceType, DummyResourceModel, { ID: 'b1947406-cdad-4c5c-9c44-8a544221b318', name: 'Dummy b1947406-cdad-4c5c-9c44-8a544221b318' }, 'e11918ea-2bd4-4d8f-bf90-2c431076e23c', 'Group', '282c1b2c-0cd4-454f-bf8f-52b450e7aee5'),
          NucleusResourceAPI.createResource.call({ $datastore, $resourceRelationshipDatastore }, resourceType, DummyResourceModel, { ID: '84247275-311c-4858-9dab-f94c655e2b34', name: 'Dummy 84247275-311c-4858-9dab-f94c655e2b34' }, 'e11918ea-2bd4-4d8f-bf90-2c431076e23c', 'Group', '282c1b2c-0cd4-454f-bf8f-52b450e7aee5'),
          NucleusResourceAPI.createResource.call({ $datastore, $resourceRelationshipDatastore }, resourceType, DummyResourceModel, { ID: '0b585001-5262-4a53-9007-d5cbc287f8ee', name: 'Dummy 0b585001-5262-4a53-9007-d5cbc287f8ee' }, 'e11918ea-2bd4-4d8f-bf90-2c431076e23c', 'Group', '282c1b2c-0cd4-454f-bf8f-52b450e7aee5')
        ]);
      });

      mocha.test("All the dummy resources are retrieved.", function () {
        const { $datastore, $resourceRelationshipDatastore } = this;

        const originUserID = 'e11918ea-2bd4-4d8f-bf90-2c431076e23c';

        return NucleusResourceAPI.retrieveBatchResourceByIDList.call({ $datastore, $logger: console, $resourceRelationshipDatastore }, 'Dummy', DummyResourceModel, [
          '22d969f8-ef02-4e31-ae5f-24f9e864a390',
          'b1947406-cdad-4c5c-9c44-8a544221b318',
          '84247275-311c-4858-9dab-f94c655e2b34',
          '0b585001-5262-4a53-9007-d5cbc287f8ee'
        ], originUserID)
          .then(({ resourceList }) => {
            chai.expect(resourceList).to.have.length(4);
            chai.expect(resourceList).to.have.nested.property('[0].resource.ID', '22d969f8-ef02-4e31-ae5f-24f9e864a390');
            chai.expect(resourceList).to.have.nested.property('[0].resource.type', 'Dummy');
            chai.expect(resourceList).to.have.nested.property(`[0].resourceRelationships.${$resourceRelationshipDatastore.authorshipPredicateName}[0].resourceID`, 'e11918ea-2bd4-4d8f-bf90-2c431076e23c');
            chai.expect(resourceList).to.have.nested.property(`[0].resourceRelationships.${$resourceRelationshipDatastore.membershipPredicateName}[0].resourceID`, '282c1b2c-0cd4-454f-bf8f-52b450e7aee5');
            chai.expect(resourceList).to.have.nested.property('[1].resource.ID', 'b1947406-cdad-4c5c-9c44-8a544221b318');
            chai.expect(resourceList).to.have.nested.property('[1].resource.type', 'Dummy');
            chai.expect(resourceList).to.have.nested.property(`[1].resourceRelationships.${$resourceRelationshipDatastore.authorshipPredicateName}[0].resourceID`, 'e11918ea-2bd4-4d8f-bf90-2c431076e23c');
            chai.expect(resourceList).to.have.nested.property(`[1].resourceRelationships.${$resourceRelationshipDatastore.membershipPredicateName}[0].resourceID`, '282c1b2c-0cd4-454f-bf8f-52b450e7aee5');
          });
      });

      // NOTE: This is failing since 673351ae15dc9b69835c8d03198997c3efe96f95
      mocha.test.skip("All the dummy resources that exist are retrieved.", function () {
        const { $datastore, $resourceRelationshipDatastore } = this;

        const originUserID = 'e11918ea-2bd4-4d8f-bf90-2c431076e23c';

        return NucleusResourceAPI.retrieveBatchResourceByIDList.call({ $datastore, $logger: console, $resourceRelationshipDatastore }, 'Dummy', DummyResourceModel, [
          '22d969f8-ef02-4e31-ae5f-24f9e864a390',
          // This resource ID doesn't exist.
          '6f06e743-0eab-4715-897a-2f5d9da52e1e',
          'b1947406-cdad-4c5c-9c44-8a544221b318',
          '84247275-311c-4858-9dab-f94c655e2b34',
          '0b585001-5262-4a53-9007-d5cbc287f8ee'
        ], originUserID)
          .then(({ resourceList }) => {
            chai.expect(resourceList).to.have.length(4);
            chai.expect(resourceList).to.have.nested.property('[0].resource.ID', '22d969f8-ef02-4e31-ae5f-24f9e864a390');
            chai.expect(resourceList).to.have.nested.property('[0].resource.type', 'Dummy');
            chai.expect(resourceList).to.have.nested.property(`[0].resourceRelationships.${$resourceRelationshipDatastore.authorshipPredicateName}[0].resourceID`, 'e11918ea-2bd4-4d8f-bf90-2c431076e23c');
            chai.expect(resourceList).to.have.nested.property(`[0].resourceRelationships.${$resourceRelationshipDatastore.membershipPredicateName}[0].resourceID`, '282c1b2c-0cd4-454f-bf8f-52b450e7aee5');
            chai.expect(resourceList).to.have.nested.property('[1].resource.ID', 'b1947406-cdad-4c5c-9c44-8a544221b318');
            chai.expect(resourceList).to.have.nested.property('[1].resource.type', 'Dummy');
            chai.expect(resourceList).to.have.nested.property(`[1].resourceRelationships.${$resourceRelationshipDatastore.authorshipPredicateName}[0].resourceID`, 'e11918ea-2bd4-4d8f-bf90-2c431076e23c');
            chai.expect(resourceList).to.have.nested.property(`[1].resourceRelationships.${$resourceRelationshipDatastore.membershipPredicateName}[0].resourceID`, '282c1b2c-0cd4-454f-bf8f-52b450e7aee5');
          });
      });

    });

    mocha.suite("#updateResourceByID", function () {

      mocha.test("The dummy resource is updated to the datastore.", async function () {
        const { $datastore, $resourceRelationshipDatastore, $$sandbox } = this;
        const $$datastoreRetrieveAllItemsFromHashByNameSpy = $$sandbox.spy($datastore, 'retrieveAllItemsFromHashByName');
        const $$datastoreAddItemToHashFieldByNameSpy = $$sandbox.spy($datastore, 'addItemToHashFieldByName');

        const dummyAttributes = {
          name: `Dummy ${uuid.v4()}`
        };
        const authorUserID = 'e11918ea-2bd4-4d8f-bf90-2c431076e23c';
        const groupID = '282c1b2c-0cd4-454f-bf8f-52b450e7aee5';

        const { resource: { ID: resourceID } } = await NucleusResourceAPI.createResource.call({ $datastore, $resourceRelationshipDatastore }, resourceType, DummyResourceModel, dummyAttributes, authorUserID, 'Group', groupID);

        const dummyAttributesToUpdate = {
          name: `Dummy ${uuid.v4()}`
        };

        return NucleusResourceAPI.updateResourceByID.call({ $datastore, $resourceRelationshipDatastore }, resourceType, DummyResourceModel, resourceID, dummyAttributesToUpdate, authorUserID)
          .then(({ resource }) => {
            chai.expect(resource).to.deep.include({
              ID: resourceID,
              name: dummyAttributesToUpdate.name,
              type: resourceType
            });

            chai.expect(resource.meta).to.have.ownProperty('updatedISOTime');

            chai.expect($$datastoreRetrieveAllItemsFromHashByNameSpy.calledOnceWith(
              NucleusResource.generateItemKey(resourceType, resourceID)
            )).to.be.true;
            chai.expect($$datastoreAddItemToHashFieldByNameSpy.calledWith(
              NucleusResource.generateItemKey(resourceType, resourceID),
              sinon.match({
                meta: sinon.match({
                  updatedISOTime: sinon.match.string
                }),
                name: dummyAttributesToUpdate.name
              })
            )).to.be.true;
          });
      });

      mocha.test("The resource relationships are returned.", async function () {
        const { $datastore, $resourceRelationshipDatastore, $$sandbox } = this;

        const dummyAttributes = {
          name: `Dummy ${uuid.v4()}`
        };
        const authorUserID = 'e11918ea-2bd4-4d8f-bf90-2c431076e23c';
        const groupID = '282c1b2c-0cd4-454f-bf8f-52b450e7aee5';

        const { resource: { ID: resourceID } } = await NucleusResourceAPI.createResource.call({ $datastore, $resourceRelationshipDatastore }, resourceType, DummyResourceModel, dummyAttributes, authorUserID, 'Group', groupID);

        const dummyAttributesToUpdate = {
          name: `Dummy ${uuid.v4()}`
        };

        return NucleusResourceAPI.updateResourceByID.call({ $datastore, $resourceRelationshipDatastore }, resourceType, DummyResourceModel, resourceID, dummyAttributesToUpdate, authorUserID)
          .then(({ resource, resourceRelationships }) => {
            chai.expect(resourceRelationships).to.be.an('object');
          });
      });

      mocha.test("The dummy resource can't be updated by a user from another branch.", async function () {
        const { $datastore, $resourceRelationshipDatastore } = this;

        const dummyAttributes = {
          name: `Dummy ${uuid.v4()}`
        };
        const authorUserID = 'e11918ea-2bd4-4d8f-bf90-2c431076e23c';
        const groupID = '282c1b2c-0cd4-454f-bf8f-52b450e7aee5';

        const { resource: { ID: resourceID } } = await NucleusResourceAPI.createResource.call({ $datastore, $resourceRelationshipDatastore }, resourceType, DummyResourceModel, dummyAttributes, authorUserID, 'Group', groupID);

        const originUserID = '1c76c8d1-8cdc-4c40-8132-36f657b5bf69';

        chai.expect(NucleusResourceAPI.updateResourceByID.call({ $datastore, $resourceRelationshipDatastore }, resourceType, DummyResourceModel, resourceID, { name: `Dummy ${uuid.v4()}` }, originUserID))
          .to.be.rejectedWith(NucleusError.UnauthorizedActionNucleusError);
      });

      mocha.suite("Intermitent update", function () {
        // Test for an issue reported on a resource becoming "unupdatable" after a few edits.

        mocha.test("The resource is updated and retrieved multiple times.", async function () {
          const { $datastore, $resourceRelationshipDatastore } = this;

          const dummyAttributes = {
            name: `Dummy ${uuid.v4()}`
          };
          const authorUserID = 'e11918ea-2bd4-4d8f-bf90-2c431076e23c';
          const groupID = '282c1b2c-0cd4-454f-bf8f-52b450e7aee5';

          const { resource: { ID: resourceID } } = await NucleusResourceAPI.createResource.call({ $datastore, $resourceRelationshipDatastore }, resourceType, DummyResourceModel, dummyAttributes, authorUserID, 'Group', groupID);

          const dummyAttributesToUpdate = {
            name: `Dummy ${uuid.v4()}`
          };

          return Promise.resolve(NucleusResourceAPI.updateResourceByID.call({ $datastore, $resourceRelationshipDatastore }, resourceType, DummyResourceModel, resourceID, dummyAttributesToUpdate, authorUserID))
            .delay(2000)
            .then(NucleusResourceAPI.retrieveResourceByID.bind({ $datastore, $resourceRelationshipDatastore }, resourceType, DummyResourceModel, resourceID, authorUserID))
            .delay(2000)
            .then(NucleusResourceAPI.updateResourceByID.bind({ $datastore, $resourceRelationshipDatastore }, resourceType, DummyResourceModel, resourceID, {
              name: `Dummy ${uuid.v4()}`
            }, authorUserID))
            .delay(2000)
            .then(NucleusResourceAPI.retrieveAllResourcesByType.bind({ $datastore, $resourceRelationshipDatastore }, resourceType, DummyResourceModel, authorUserID, 'TopNodeDescent'))
            .delay(2000)
            .then(NucleusResourceAPI.updateResourceByID.bind({ $datastore, $resourceRelationshipDatastore }, resourceType, DummyResourceModel, resourceID, {
              name: `Dummy ${uuid.v4()}`
            }, authorUserID))
            .delay(2000)
            .then(NucleusResourceAPI.retrieveResourceByID.bind({ $datastore, $resourceRelationshipDatastore }, resourceType, DummyResourceModel, resourceID, authorUserID))
            .delay(2000)
            .then(NucleusResourceAPI.updateResourceByID.bind({ $datastore, $resourceRelationshipDatastore }, resourceType, DummyResourceModel, resourceID, {
              name: `Dummy ${uuid.v4()}`
            }, authorUserID))
            .delay(2000)
            .then(NucleusResourceAPI.retrieveAllResourcesByType.bind({ $datastore, $resourceRelationshipDatastore }, resourceType, DummyResourceModel, authorUserID, 'TopNodeDescent'))
            .delay(2000)
            .then(NucleusResourceAPI.updateResourceByID.bind({ $datastore, $resourceRelationshipDatastore }, resourceType, DummyResourceModel, resourceID, {
              name: `Dummy ${uuid.v4()}`
            }, authorUserID));
        });

      });

    });

    mocha.suite("Retrieve all performance", function () {
      const dummyCountList = [ 50, 200, 400, 800, 1600 ];

      // Original benchmark is 200 items retrieved in 19 seconds.
      // After modification, the resources are retrieved in 280ms (without relationships)

      // 200 dummies => 195ms
      // 400 dummies => 399ms
      // 800 dummies => 904ms
      // 1600 dummies => 2300ms
      dummyCountList
        .forEach((dummyCount) => {

          mocha.suite(`${dummyCount} dummies`, function () {
            const attemptCountList = [1, 3, 5];

            mocha.setup(function () {
              const { $datastore, $resourceRelationshipDatastore } = this;

              console.time("Setup");
              return Promise.all(Array.apply(null, { length: dummyCount })
                .map(() => {
                  const ID = uuid.v4();

                  return NucleusResourceAPI.createResource.call({ $datastore, $resourceRelationshipDatastore }, resourceType, DummyResourceModel, { ID, name: `Dummy ${ID}` }, 'e11918ea-2bd4-4d8f-bf90-2c431076e23c', 'Group', '282c1b2c-0cd4-454f-bf8f-52b450e7aee5');
                }))
                .then(console.timeEnd.bind(console, "Setup"));
            });

            attemptCountList
              .forEach((attemptCount) => {

                mocha.test(`All the dummy resources are retrieved. ${attemptCount} attempts`, function () {
                  const { $datastore, $resourceRelationshipDatastore } = this;

                  const originUserID = 'e11918ea-2bd4-4d8f-bf90-2c431076e23c';

                  console.time(`Retrieve all (${attemptCount} attempt(s))`);

                  return NucleusResourceAPI.retrieveAllResourcesByType.call({ $datastore, $resourceRelationshipDatastore }, 'Dummy', DummyResourceModel, originUserID)
                    .then(({ resourceList }) => {
                      // The user retrieve 202 dummies.
                      chai.expect(resourceList).to.have.length(dummyCount);
                      chai.expect(resourceList[0]).to.have.property('resource');
                      chai.expect(resourceList[0]).to.have.nested.property('resource.ID');
                      chai.expect(resourceList[0]).to.have.property('resourceRelationships');
                      chai.expect(resourceList[0]).to.have.nested.property(`resourceRelationships.${$resourceRelationshipDatastore.authorshipPredicateName}`);
                      chai.expect(resourceList[0]).to.have.nested.property(`resourceRelationships.${$resourceRelationshipDatastore.membershipPredicateName}`);

                      console.timeEnd(`Retrieve all (${attemptCount} attempt(s))`);
                    })
                    .then(() => {

                      return Promise.all(Array.apply(null, { length: attemptCount - 1 }))
                        .map(() => {

                          return NucleusResourceAPI.retrieveAllResourcesByType.call({ $datastore, $resourceRelationshipDatastore }, 'Dummy', DummyResourceModel, originUserID);
                        });
                    });
                });

              });

          });

        });

    });

  });

  mocha.suite("Archive", function () {

    class ArchiveTestResourceModel extends NucleusResource {

      constructor (resourceAttributes, authorUserID) {
        super('Dummy', {}, resourceAttributes, authorUserID);
      }

    }

    mocha.setup(function () {
      const { $datastore, $resourceRelationshipDatastore } = this;

      // Given this structure
      //
      // SYSTEM
      //   +
      //   +-> Group <dc828ae2-6aca-4ede-8081-f703af2d6471>
      //   |    +
      //   |    +-> User <fcc66afe-3d80-4225-bd1f-7a34bd26f403>
      //   |    |
      //   |    +-> User <0b4d9c2c-efca-4e3f-8541-8e4cfe788cd9>
      //   |    |
      //   |    +-> Resource <c6c1f7df-d254-4e43-a903-fc362dce49db>
      //   |
      //   +-> Group <8e847a4b-1a42-449d-a7e9-7a6b04ab51f7>
      //        +
      //        +-> User <c5237d73-bf40-4fda-9dee-c6d8b29acd05>
      //        |
      //        +-> Resource <54982ac9-bf59-4441-aefd-51c519dfcaa8>

      const groupNodeA = {
        type: 'Group',
        ID: 'dc828ae2-6aca-4ede-8081-f703af2d6471'
      };
      const groupNodeB = {
        type: 'Group',
        ID: '8e847a4b-1a42-449d-a7e9-7a6b04ab51f7'
      };
      const userNodeA = {
        type: 'User',
        ID: '135a6832-cd5f-4097-b2a5-4b1a7c5e229c'
      };
      const userNodeB = {
        type: 'User',
        ID: '0b4d9c2c-efca-4e3f-8541-8e4cfe788cd9'
      };
      const userNodeC = {
        type: 'User',
        ID: 'c5237d73-bf40-4fda-9dee-c6d8b29acd05'
      };
      const resourceNodeA = {
        type: 'Resource',
        ID: 'c6c1f7df-d254-4e43-a903-fc362dce49db'
      };
      const resourceNodeB = {
        type: 'Resource',
        ID: '54982ac9-bf59-4441-aefd-51c519dfcaa8'
      };

      const resourceRelationshipListByResourceNode = {
        [`${userNodeA.type}-${userNodeA.ID}`]: [
          {
            relationship: 'is-member-of',
            resourceID: groupNodeA.ID,
            resourceType: groupNodeA.type
          }
        ],
        [`${userNodeB.type}-${userNodeB.ID}`]: [
          {
            relationship: 'is-authored-by',
            resourceID: userNodeA.ID,
            resourceType: userNodeA.type
          },
          {
            relationship: 'is-member-of',
            resourceID: groupNodeA.ID,
            resourceType: groupNodeA.type
          }
        ],
        [`${resourceNodeA.type}-${resourceNodeA.ID}`]: [
          {
            relationship: 'is-authored-by',
            resourceID: userNodeB.ID,
            resourceType: userNodeB.type
          },
          {
            relationship: 'is-member-of',
            resourceID: groupNodeA.ID,
            resourceType: groupNodeA.type
          }
        ],
        [`${userNodeC.type}-${userNodeC.ID}`]: [
          {
            relationship: 'is-member-of',
            resourceID: groupNodeB.ID,
            resourceType: groupNodeB.type
          }
        ],
        [`${resourceNodeB.type}-${resourceNodeB.ID}`]: [
          {
            relationship: 'is-authored-by',
            resourceID: userNodeC.ID,
            resourceType: userNodeC.type
          },
          {
            relationship: 'is-member-of',
            resourceID: groupNodeB.ID,
            resourceType: groupNodeB.type
          }
        ]
      };

      return Promise.all(Object.keys(resourceRelationshipListByResourceNode)
        .map((stringifiedSubjectNode) => {
          const resourceRelationshipList = resourceRelationshipListByResourceNode[stringifiedSubjectNode];

          return Promise.all(resourceRelationshipList
            .map((resourceRelationship) => {
              const { resourceID, relationship: predicate, resourceType } = resourceRelationship;
              const resourceItemKey = NucleusResource.generateItemKey(resourceType, resourceID);

              return Promise.all([
                $resourceRelationshipDatastore.createRelationshipBetweenSubjectAndObject(stringifiedSubjectNode, predicate, `${resourceType}-${resourceID}`),
                $datastore.addItemToHashFieldByName(resourceItemKey, { ID: resourceID, meta: {}, type: resourceType })
              ]);
            }));
        }));
    });

    // TODO: Implement a way to retrieve archived relationships specifically;

    mocha.test('Relationships to the subject node are achived.', async function () {
      const { $datastore, $resourceRelationshipDatastore } = this;

      const { resourceList } = await NucleusResourceAPI.retrieveAllResourcesByType.call({ $datastore, $resourceRelationshipDatastore }, 'User', ArchiveTestResourceModel, '0b4d9c2c-efca-4e3f-8541-8e4cfe788cd9');

      chai.expect(resourceList).to.have.length(2);

      // User B archives User A...
      return NucleusResourceAPI.archiveResourceByID.call({ $datastore, $resourceRelationshipDatastore }, 'User', '135a6832-cd5f-4097-b2a5-4b1a7c5e229c', '0b4d9c2c-efca-4e3f-8541-8e4cfe788cd9')
        .then(async () => {

          const { resourceList } = await NucleusResourceAPI.retrieveAllResourcesByType.call({ $datastore, $resourceRelationshipDatastore }, 'User', ArchiveTestResourceModel, '0b4d9c2c-efca-4e3f-8541-8e4cfe788cd9');

          // The resource is no longer retrieved when searching by relationship...
          chai.expect(resourceList).to.have.length(1);

          // But can be retrieved if requested directly...
          const { resource } = await NucleusResourceAPI.retrieveResourceByID.call({ $datastore, $resourceRelationshipDatastore }, 'User', ArchiveTestResourceModel, '135a6832-cd5f-4097-b2a5-4b1a7c5e229c', '0b4d9c2c-efca-4e3f-8541-8e4cfe788cd9');

          chai.expect(resource.meta).to.have.property('archivedISOTime');
        });
    });

  });

});

/**
 * Generates a given hierarchy tree in the relationship datastore.
 * @example
 * // Each nested array represent a branch of the tree.
 * // Each value of the nested array represents a node.
 * // `0da2e0ec` is a child of `bebffed5` which is a child of `1fb6d396` which is a child of `SYSTEM`...
 * generateHierarchyTree([
 *   [ 'SYSTEM', '1fb6d396-dd72-4943-9528-06db943d17d8', 'bebffed5-d356-41d9-a4ed-32d33bba5127', '0da2e0ec-02a1-4756-89f5-5bf2c2d3664a' ],
 *   [ 'SYSTEM', '1fb6d396-dd72-4943-9528-06db943d17d8', '61fc9214-da8a-4426-8baf-b04565e87d4c' ],
 * ]);
 *
 * @argument {Array[]} treeBranchList
 *
 * @returns {Promise}
 */
function generateHierarchyTree (treeBranchList) {
  const { $resourceRelationshipDatastore } = this;

  return Promise.all(treeBranchList
    .slice(0)
    .map((branchNodeIDList) => {

      return Promise.all(branchNodeIDList
        .slice(0)
        .reverse()
        .map((node, index, array) => {
          const ancestorNode = array[index + 1];

          if (!ancestorNode) return Promise.resolve();

          const { type: ancestorNodeType, ID: ancestorNodeID } = ancestorNode;
          const { type: nodeType, ID: nodeID } = node;

          $resourceRelationshipDatastore.createRelationshipBetweenSubjectAndObject(
            (nucleusValidator.isObject(node)) ? `${nodeType}-${nodeID}` : node,
            $resourceRelationshipDatastore.membershipPredicateName,
            (nucleusValidator.isObject(ancestorNode)) ? `${ancestorNodeType}-${ancestorNodeID}` : ancestorNode
          );
        }));
    }));
}