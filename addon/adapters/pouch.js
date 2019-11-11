import { assert } from '@ember/debug';
import { getOwner } from '@ember/application';
import { get } from '@ember/object';
import { on } from '@ember/object/evented';
import { isEmpty } from '@ember/utils';
import { bind } from '@ember/runloop';
import { classify, camelize } from '@ember/string';

import DS from 'ember-data';
import { pluralize } from 'ember-inflector';
import RSVP from 'rsvp';
import { v4 } from 'uuid';
//import BelongsToRelationship from 'ember-data/-private/system/relationships/state/belongs-to';

import {
  extractDeleteRecord,
  shouldSaveRelationship,
  configFlagDisabled
} from '../utils';

//BelongsToRelationship.reopen({
//  findRecord() {
//    return this._super().catch(() => {
//      //not found: deleted
//      this.clear();
//    });
//  }
//});

export default DS.RESTAdapter.extend({
  fixDeleteBug: true,
  coalesceFindRequests: false,

  init() {
    this._super(arguments);
    this._indexPromises = [];
    this.createdRecords = {};
    this.waitingForConsistency = {};
  },

  // The change listener ensures that individual records are kept up to date
  // when the data in the database changes. This makes ember-data 2.0's record
  // reloading redundant.
  shouldReloadRecord: function () { return false; },
  shouldBackgroundReloadRecord: function () { return false; },
  _onInit: on('init', function()  {
    this._startChangesToStoreListener();
  }),
  _startChangesToStoreListener: function() {
    const db = this.get('db');
    if (db && !this.changes) { // only run this once
      const onChangeListener = bind(this, 'onChange');
      this.set('onChangeListener', onChangeListener);
      this.changes = db.changes({
        since: 'now',
        live: true,
        returnDocs: false
      });
      this.changes.on('change', onChangeListener);
    }
  },

  _stopChangesListener: function() {
    if (this.changes) {
      const onChangeListener = this.get('onChangeListener');
      this.changes.removeListener('change', onChangeListener);
      this.changes.cancel();
      this.changes = undefined;
    }
  },
  changeDb: function(db) {
    this._stopChangesListener();

    const store = this.store;
    const schema = this._schema || [];

    for (let i = 0, len = schema.length; i < len; i++) {
      store.unloadAll(schema[i].singular);
    }

    this._schema = null;
    this.set('db', db);
    this._startChangesToStoreListener();
  },
  onChange: function (change) {
    // If relational_pouch isn't initialized yet, there can't be any records
    // in the store to update.
    if (!this.get('db').rel) { return; }

    const obj = this.get('db').rel.parseDocID(change.id);
    // skip changes for non-relational_pouch docs. E.g., design docs.
    if (!obj.type || !obj.id || obj.type === '') { return; }

    if (this.waitingForConsistency[change.id]) {
      const promise = this.waitingForConsistency[change.id];
      delete this.waitingForConsistency[change.id];
      if (change.deleted) {
        promise.reject("deleted");
      } else {
        promise.resolve(this._findRecord(obj.type, obj.id));
      }
      return;
    }

    const store = this.store;
    try {
      store.modelFor(obj.type);
    } catch (e) {
      // The record refers to a model which this version of the application
      // does not have.
      return;
    }

    const recordInStore = store.peekRecord(obj.type, obj.id);
    if (!recordInStore) {
      // The record hasn't been loaded into the store; no need to reload its data.
      if (this.createdRecords[obj.id]) {
        delete this.createdRecords[obj.id];
      } else {
        this.unloadedDocumentChanged(obj);
      }
      return;
    }
    if (!recordInStore.get('isLoaded') || recordInStore.get('rev') === change.changes[0].rev || recordInStore.get('hasDirtyAttributes')) {
      // The record either hasn't loaded yet or has unpersisted local changes.
      // In either case, we don't want to refresh it in the store
      // (and for some substates, attempting to do so will result in an error).
      // We also ignore the change if we already have the latest revision
      return;
    }

    if (change.deleted) {
      if (this.fixDeleteBug) {
        recordInStore._internalModel.transitionTo('deleted.saved');//work around ember-data bug
      } else {
        store.unloadRecord(recordInStore);
      }
    } else {
      recordInStore.reload();
    }
  },

  unloadedDocumentChanged: function(/* obj */) {
    /*
     * For performance purposes, we don't load records into the store that haven't previously been loaded.
     * If you want to change this, subclass this method, and push the data into the store. e.g.
     *
     *  let store = this.get('store');
     *  let recordTypeName = this.getRecordTypeName(store.modelFor(obj.type));
     *  this.get('db').rel.find(recordTypeName, obj.id).then(function(doc){
     *    store.pushPayload(recordTypeName, doc);
     *  });
     */
  },

  willDestroy: function() {
    this._stopChangesListener();
  },

  _indexPromises: null,

  _init: function (store, type) {
    const self = this,
        recordTypeName = this.getRecordTypeName(type);
    if (!this.get('db') || typeof this.get('db') !== 'object') {
      throw new Error('Please set the `db` property on the adapter.');
    }

    if (!get(type, 'attributes').has('rev')) {
      const modelName = classify(recordTypeName);
      throw new Error('Please add a `rev` attribute of type `string`' +
        ' on the ' + modelName + ' model.');
    }

    this._schema = this._schema || [];

    const singular = recordTypeName;
    const plural = pluralize(recordTypeName);

    // check that we haven't already registered this model
    for (let i = 0, len = this._schema.length; i < len; i++) {
      const currentSchemaDef = this._schema[i];
      if (currentSchemaDef.singular === singular) {
        return;
      }
    }

    const schemaDef = {
      singular: singular,
      plural: plural
    };

    if (type.documentType) {
      schemaDef['documentType'] = type.documentType;
    }

    let config = getOwner(this).resolveRegistration('config:environment');
    // else it's new, so update
    this._schema.push(schemaDef);
    // check all the subtypes
    // We check the type of `rel.type`because with ember-data beta 19
    // `rel.type` switched from DS.Model to string
    type.eachRelationship(function (_, rel) {
      if (rel.kind !== 'belongsTo' && rel.kind !== 'hasMany') {
        // TODO: support inverse as well
        return; // skip
      }
      const relDef = {},
          relModel = (typeof rel.type === 'string' ? store.modelFor(rel.type) : rel.type);
      if (relModel) {
        let includeRel = true;
        if (!('options' in rel)) {
          rel.options = {};
        }
        if (typeof(rel.options.async) === "undefined") {
          rel.options.async = config.emberPouch && !isEmpty(config.emberPouch.async) ? config.emberPouch.async : true;//default true from https://github.com/emberjs/data/pull/3366
        }
        let options = Object.create(rel.options);
        if (rel.kind === 'hasMany' && !shouldSaveRelationship(self, rel)) {
          let inverse = type.inverseFor(rel.key, store);
          if (inverse) {
            if (inverse.kind === 'belongsTo') {
              self._indexPromises.push(self.get('db').createIndex({index: { fields: ['data.' + inverse.name, '_id'] }}));
              if (options.async) {
                includeRel = false;
              } else {
                options.queryInverse = inverse.name;
              }
            }
          }
        }

        if (includeRel) {
          relDef[rel.kind] = {
            type: self.getRecordTypeName(relModel),
            options: options
          };
          if (!schemaDef.relations) {
            schemaDef.relations = {};
          }
          schemaDef.relations[rel.key] = relDef;
        }
        self._init(store, relModel);
      }
    });

    this.get('db').setSchema(this._schema);
  },

  _recordToData: function (store, type, record) {
    let data = {};
    // Though it would work to use the default recordTypeName for modelName &
    // serializerKey here, these uses are conceptually distinct and may vary
    // independently.
    const modelName = type.modelName || type.typeKey;
    const serializerKey = camelize(modelName);
    const serializer = store.serializerFor(modelName);

    serializer.serializeIntoHash(
      data,
      type,
      record,
      {includeId: true}
    );

    data = data[serializerKey];

    // ember sets it to null automatically. don't need it.
    if (data.rev === null) {
      delete data.rev;
    }

    return data;
  },

  /**
   * Return key that conform to data adapter
   * ex: 'name' become 'data.name'
   */
  _dataKey: (key) => `data.${key}`,

  /**
   * Returns the modified selector key to comform data key
   * Ex: selector: {name: 'Mario'} wil become selector: {'data.name': 'Mario'}
   */
  _buildSelector: function(selector) {
    const dataSelector = {};
    const selectorKeys = [];

    for (let key in selector) {
      if(selector.hasOwnProperty(key)){
        selectorKeys.push(key);
      }
    }

    selectorKeys.forEach(function(key) {
      const dataKey = this._dataKey(key);
      dataSelector[dataKey] = selector[key];
    }.bind(this));

    return dataSelector;
  },

  /**
   * Returns the modified sort key
   * Ex: sort: ['series'] will become ['data.series']
   * Ex: sort: [{series: 'desc'}] will became [{'data.series': 'desc'}]
   */
  _buildSort: function(sort) {
    return sort.map(function (value) {
      const sortKey = {};
      if (typeof value === 'object' && value !== null) {
        for (let key in value) {
          if(value.hasOwnProperty(key)){
            sortKey[this._dataKey(key)] = value[key];
          }
        }
      } else {
        return this._dataKey(value);
      }
      return sortKey;
    }.bind(this));
  },

  /**
   * Returns the string to use for the model name part of the PouchDB document
   * ID for records of the given ember-data type.
   *
   * This method uses the camelized version of the model name in order to
   * preserve data compatibility with older versions of ember-pouch. See
   * pouchdb-community/ember-pouch#63 for a discussion.
   *
   * You can override this to change the behavior. If you do, be aware that you
   * need to execute a data migration to ensure that any existing records are
   * moved to the new IDs.
   */
  getRecordTypeName(type) {
    return camelize(type.modelName);
  },

  findAll: function(store, type /*, sinceToken */) {
    // TODO: use sinceToken
    this._init(store, type);
    return this.get('db').rel.find(this.getRecordTypeName(type));
  },

  findMany: function(store, type, ids) {
    this._init(store, type);
    return this.get('db').rel.find(this.getRecordTypeName(type), ids);
  },

  findHasMany: function(store, record, link, rel) {
    let inverse = record.type.inverseFor(rel.key, store);
    if (inverse && inverse.kind === 'belongsTo') {
      return this.get('db').rel.findHasMany(camelize(rel.type), inverse.name, record.id);
    } else {
      let result = {};
      result[pluralize(rel.type)] = [];
      return result; //data;
    }
  },

  query: function(store, type, query) {
    this._init(store, type);

    const recordTypeName = this.getRecordTypeName(type);
    const db = this.get('db');

    const queryParams = {
      selector: this._buildSelector(query.filter)
    };

    if (!isEmpty(query.sort)) {
      queryParams.sort = this._buildSort(query.sort);
    }

    if (!isEmpty(query.limit)) {
      queryParams.limit = query.limit;
    }

    if (!isEmpty(query.skip)) {
      queryParams.skip = query.skip;
    }

    return db.find(queryParams).then(pouchRes => db.rel.parseRelDocs(recordTypeName, pouchRes.docs));
  },

  queryRecord: function(store, type, query) {
    return this.query(store, type, query).then(results => {
      const recordType = this.getRecordTypeName(type);
      const recordTypePlural = pluralize(recordType);
      if(results[recordTypePlural].length > 0){
        results[recordType] = results[recordTypePlural][0];
      } else {
        results[recordType] = null;
      }
      delete results[recordTypePlural];
      return results;
    });
  },

  /**
   * `find` has been deprecated in ED 1.13 and is replaced by 'new store
   * methods', see: https://github.com/emberjs/data/pull/3306
   * We keep the method for backward compatibility and forward calls to
   * `findRecord`. This can be removed when the library drops support
   * for deprecated methods.
  */
  find: function (store, type, id) {
    return this.findRecord(store, type, id);
  },

  findRecord: function (store, type, id) {
    this._init(store, type);
    const recordTypeName = this.getRecordTypeName(type);
    return this._findRecord(recordTypeName, id);
  },

  _findRecord(recordTypeName, id) {
    return this.get('db').rel.find(recordTypeName, id).then(payload => {
      // Ember Data chokes on empty payload, this function throws
      // an error when the requested data is not found
      if (typeof payload === 'object' && payload !== null) {
        const singular = recordTypeName;
        const plural = pluralize(recordTypeName);

        const results = payload[singular] || payload[plural];
        if (results && results.length > 0) {
          return payload;
        }
      }

      if (configFlagDisabled(this, 'eventuallyConsistent'))
        throw new Error("Document of type '" + recordTypeName + "' with id '" + id + "' not found.");
      else
        return this._eventuallyConsistent(recordTypeName, id);
    });
  },

  //TODO: cleanup promises on destroy or db change?
  waitingForConsistency: null,
  _eventuallyConsistent: function(type, id) {
    let pouchID = this.get('db').rel.makeDocID({type, id});
    let defer = RSVP.defer();
    this.waitingForConsistency[pouchID] = defer;

    return this.get('db').rel.isDeleted(type, id).then(deleted => {
      //TODO: should we test the status of the promise here? Could it be handled in onChange already?
      if (deleted) {
        delete this.waitingForConsistency[pouchID];
        throw new Error("Document of type '" + type + "' with id '" + id + "' is deleted.");
      } else if (deleted === null) {
        return defer.promise;
      } else {
        assert('Status should be existing', deleted === false);
        //TODO: should we reject or resolve the promise? or does JS GC still clean it?
        if (this.waitingForConsistency[pouchID]) {
          delete this.waitingForConsistency[pouchID];
          return this._findRecord(type, id);
        } else {
          //findRecord is already handled by onChange
          return defer.promise;
        }
      }
    });
  },

  generateIdForRecord: function(/* store, type, inputProperties */) {
    return v4();
  },

  createdRecords: null,
  createRecord: function(store, type, snapshot) {
    const record = snapshot.record;
    if (record._emberPouchSavePromise) {
      const changes = record.changedAttributes();
      record._emberPouchSavePromise = record._emberPouchSavePromise.then(records => {
        // If there have been changes since the document was created then we should update the record now
        if (Object.keys(changes).length > 0) {
          const rev = records[Object.keys(records)[0]][0].rev;
          (snapshot.__attributes || snapshot._attributes).rev = rev; // FIXME: it should be possible to do this elsewhere
          return this.updateRecord(store, type, snapshot);
        }
        return records;
      });
      return record._emberPouchSavePromise;
    }

    this._init(store, type);
    const data = this._recordToData(store, type, snapshot);
    const rel = this.get('db').rel;
    const id = data.id;
    this.createdRecords[id] = true;
    Object.defineProperty(record, '_emberPouchSavePromise', {
      enumerable: false,
      writable: true,
      value: rel.save(this.getRecordTypeName(type), data).catch((e) => {
        delete this.createdRecords[id];
        throw e;
      }),
    });
    return record._emberPouchSavePromise;
  },

  updateRecord: function (store, type, snapshot) {
    this._init(store, type);
    const data = this._recordToData(store, type, snapshot);
    return this.get('db').rel.save(this.getRecordTypeName(type), data);
  },

  deleteRecord: function (store, type, record) {
    this._init(store, type);
    const data = this._recordToData(store, type, record);
    return this.get('db').rel.del(this.getRecordTypeName(type), data)
      .then(extractDeleteRecord);
  }
});
