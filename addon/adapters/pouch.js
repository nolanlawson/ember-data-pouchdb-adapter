import Ember from 'ember';
import DS from 'ember-data';

import {
  extractDeleteRecord
} from 'ember-pouch/utils';

const {
  assert,
  run: {
    bind,
    later,
    cancel
  },
  on,
  observer,
  String: {
    pluralize,
    camelize,
    classify
  },
  RSVP
} = Ember;

export default DS.RESTAdapter.extend({
  coalesceFindRequests: true,
  liveSync: true,
  syncInterval: null,

  liveChanges: null,
  syncChanges: null,
  syncTimer: null,
  lastSeq: null,

  // The change listener ensures that individual records are kept up to date
  // when the data in the database changes. This makes ember-data 2.0's record
  // reloading redundant.
  shouldReloadRecord: function () { return false; },
  shouldBackgroundReloadRecord: function () { return false; },
  _liveSyncHandler: observer('liveSync', 'db', function () {
    if (this.liveChanges) {
      this.liveChanges.cancel();
    }
    var db = this.get('db');
    if (this.get('liveSync') && db) {
      this.liveChanges = db.changes({
        since: 'now',
        live: true,
        returnDocs: false
      }).on('change', bind(this, 'onChange'));
    }
  }),
  _syncIntervalHandler: observer('syncInterval', 'db', function () {
    cancel(this.syncTimer);
    if (this.get('syncInterval')) {
      assert("Only one of liveSync or syncInterval should be used for a given adapter",
        !this.get('liveSync')
      );
      this._scheduleSync();
    }
  }),
  _scheduleSync() {
    cancel(this.syncTimer);
    this.syncTimer = later(() => {
      this.sync();
      this._scheduleSync();
    }, this.get('syncInterval'));
  },
  sync() {
    var db = this.get('db');
    if (!db) {
      throw new Error("Can't sync without a db");
    }
    return (this.lastSeq ? RSVP.resolve(this.lastSeq) :
      db.info().then(info => info.update_seq)
    ).then(sinceSeq => new RSVP.Promise((resolve, reject) => {
      if (this.syncChanges) {
        this.syncChanges.cancel();
      }
      this.syncChanges = db.changes({
        since: sinceSeq,
        returnDocs: false
      }).on('complete', ev => {
        this.lastSeq = ev.last_seq;
        resolve(ev);
      }).on('error', reject);
      if (!this.get('liveSync')) {
        this.syncChanges.on('change', bind(this, 'onChange'));
      }
    }));
  },
  _startSyncing: on('init', function() {
    this._liveSyncHandler();
    this._syncIntervalHandler();
  }),
  _stopSyncing() {
    if (this.liveChanges) {
      this.liveChanges.cancel();
    }
    if (this.syncTimer) {
      cancel(this.syncTimer);
    }
    if (this.syncChanges) {
      this.syncChanges.cancel();
    }
  },
  changeDb: function(db) {
    this._stopSyncing();
    var store = this.store;
    var schema = this._schema || [];

    for (var i = 0, len = schema.length; i < len; i++) {
      store.unloadAll(schema[i].singular);
    }

    this._schema = null;
    this.set('db', db);
  },
  onChange: function (change) {
    // If relational_pouch isn't initialized yet, there can't be any records
    // in the store to update.
    if (!this.get('db').rel) { return; }

    var obj = this.get('db').rel.parseDocID(change.id);
    // skip changes for non-relational_pouch docs. E.g., design docs.
    if (!obj.type || !obj.id || obj.type === '') { return; }

    var store = this.store;

    try {
      store.modelFor(obj.type);
    } catch (e) {
      // The record refers to a model which this version of the application
      // does not have.
      return;
    }

    var recordInStore = store.peekRecord(obj.type, obj.id);
    if (!recordInStore) {
      // The record hasn't been loaded into the store; no need to reload its data.
      this.unloadedDocumentChanged(obj);
      return;
    }
    if (!recordInStore.get('isLoaded') || recordInStore.get('hasDirtyAttributes')) {
      // The record either hasn't loaded yet or has unpersisted local changes.
      // In either case, we don't want to refresh it in the store
      // (and for some substates, attempting to do so will result in an error).
      return;
    }

    if (change.deleted) {
      store.unloadRecord(recordInStore);
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
    this._stopSyncing();
  },

  _init: function (store, type) {
    var self = this,
        recordTypeName = this.getRecordTypeName(type);
    if (!this.get('db') || typeof this.get('db') !== 'object') {
      throw new Error('Please set the `db` property on the adapter.');
    }

    if (!Ember.get(type, 'attributes').has('rev')) {
      var modelName = classify(recordTypeName);
      throw new Error('Please add a `rev` attribute of type `string`' +
        ' on the ' + modelName + ' model.');
    }

    this._schema = this._schema || [];

    var singular = recordTypeName;
    var plural = pluralize(recordTypeName);

    // check that we haven't already registered this model
    for (var i = 0, len = this._schema.length; i < len; i++) {
      var currentSchemaDef = this._schema[i];
      if (currentSchemaDef.singular === singular) {
        return;
      }
    }

    var schemaDef = {
      singular: singular,
      plural: plural
    };

    if (type.documentType) {
      schemaDef['documentType'] = type.documentType;
    }

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
      var relDef = {},
          relModel = (typeof rel.type === 'string' ? store.modelFor(rel.type) : rel.type);
      if (relModel) {
        relDef[rel.kind] = {
          type: self.getRecordTypeName(relModel),
          options: rel.options
        };
        if (!schemaDef.relations) {
          schemaDef.relations = {};
        }
        schemaDef.relations[rel.key] = relDef;
        self._init(store, relModel);
      }
    });

    this.get('db').setSchema(this._schema);
  },

  _recordToData: function (store, type, record) {
    var data = {};
    // Though it would work to use the default recordTypeName for modelName &
    // serializerKey here, these uses are conceptually distinct and may vary
    // independently.
    var modelName = type.modelName || type.typeKey;
    var serializerKey = camelize(modelName);
    var serializer = store.serializerFor(modelName);

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
  _dataKey: function(key) {
    var dataKey ='data.' + key;
    return ""+ dataKey + "";
  },

  /**
   * Returns the modified selector key to comform data key
   * Ex: selector: {name: 'Mario'} wil become selector: {'data.name': 'Mario'}
   */
  _buildSelector: function(selector) {
    var dataSelector = {};
    var selectorKeys = [];

    for (var key in selector) {
      if(selector.hasOwnProperty(key)){
        selectorKeys.push(key);
      }
    }

    selectorKeys.forEach(function(key) {
      var dataKey = this._dataKey(key);
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
      var sortKey = {};
      if (typeof value === 'object' && value !== null) {
        for (var key in value) {
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
   * nolanlawson/ember-pouch#63 for a discussion.
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


  query: function(store, type, query) {
    this._init(store, type);

    var recordTypeName = this.getRecordTypeName(type);
    var db = this.get('db');

    var queryParams = {
      selector: this._buildSelector(query.filter)
    };

    if (!Ember.isEmpty(query.sort)) {
      queryParams.sort = this._buildSort(query.sort);
    }

    return db.find(queryParams).then(function (payload) {
      if (typeof payload === 'object' && payload !== null) {
        var plural = pluralize(recordTypeName);
        var results = {};

        var rows = payload.docs.map((row) => {
          var parsedId = db.rel.parseDocID(row._id);
          if (!Ember.isEmpty(parsedId.id)) {
            row.data.id = parsedId.id;
            return row.data;
          }
        });

        results[plural] = rows;

        return results;
      }
    });
  },

  queryRecord: function(store, type, query) {
    return this.query(store, type, query);
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
    var recordTypeName = this.getRecordTypeName(type);
    return this.get('db').rel.find(recordTypeName, id).then(function (payload) {
      // Ember Data chokes on empty payload, this function throws
      // an error when the requested data is not found
      if (typeof payload === 'object' && payload !== null) {
        var singular = recordTypeName;
        var plural = pluralize(recordTypeName);

        var results = payload[singular] || payload[plural];
        if (results && results.length > 0) {
          return payload;
        }
      }
      throw new Error('Not found: type "' + recordTypeName +
        '" with id "' + id + '"');
    });
  },

  createRecord: function(store, type, record) {
    this._init(store, type);
    var data = this._recordToData(store, type, record);
    return this.get('db').rel.save(this.getRecordTypeName(type), data);
  },

  updateRecord: function (store, type, record) {
    this._init(store, type);
    var data = this._recordToData(store, type, record);
    return this.get('db').rel.save(this.getRecordTypeName(type), data);
  },

  deleteRecord: function (store, type, record) {
    this._init(store, type);
    var data = this._recordToData(store, type, record);
    return this.get('db').rel.del(this.getRecordTypeName(type), data)
      .then(extractDeleteRecord);
  }
});
