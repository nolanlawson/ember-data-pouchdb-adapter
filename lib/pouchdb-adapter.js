export default DS.RESTAdapter.extend({

  //db: new PouchDB('http://localhost:5984/ember-todo'),

  _init: function (type) {
    var self = this;
    if (!this.db || typeof this.db !== 'object') {
      throw new Error('Please set the `db` property on the adapter.');
    }

    this._schema = this._schema || [];

    var singular = type.typeKey;
    var plural = Ember.String.pluralize(type.typeKey);

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

    // else it's new, so update
    this._schema.push(schemaDef);

    // check all the subtypes
    type.eachRelationship(function (_, rel) {
      if (rel.kind !== 'belongsTo' && rel.kind !== 'hasMany') {
        // TODO: support inverse as well
        return; // skip
      }
      var relDef = {};
      relDef[rel.kind] = {
        type: rel.type.typeKey,
        options: rel.options
      };
      if (!schemaDef.relations) {
        schemaDef.relations = {};
      }
      schemaDef.relations[rel.key] = relDef;
      self._init(rel.type);
    });

    this.db.setSchema(this._schema);

    this.changes = this.db.changes({
      since: 'now',
      live: true
    }).on('change', function (change) {
      var obj = this.db.rel.parseDocID(change.id);
      var store = this.container.lookup('store:main');

      store.findAll(obj.type);

      if (change.deleted) {
        var rec = store.recordForId(obj.type, obj.id);
        store.unloadRecord(rec);
      }
    }.bind(this));
  },

  willDestroy: function() {
    this.changes.cancel();
  },

  _recordToData: function (store, type, record) {
    var data = {};
    var serializer = store.serializerFor(type.typeKey);

    serializer.serializeIntoHash(data, type, record, { includeId: true });

    data = data[type.typeKey];

    // ember sets it to null automatically. don't need it.
    if (data.rev === null) {
      delete data.rev;
    }

    return data;
  },

  findAll: function(store, type /*, sinceToken */) {
    // TODO: use sinceToken
    this._init(type);
    return this.db.rel.find(type.typeKey);
  },

  findMany: function(store, type, ids) {
    this._init(type);
    return this.db.rel.find(type.typeKey, ids);
  },

  findQuery: function(/* store, type, query */) {
    throw new Error(
      "findQuery not yet supported by ember-pouch. " +
      "See https://github.com/nolanlawson/ember-pouch/issues/7.");
  },

  find: function (store, type, id) {
    this._init(type);
    return this.db.rel.find(type.typeKey, id).then(function (payload) {
      // Ember Data chokes on empty payload, this function throws
      // an error when the requested data is not found
      if (typeof payload === 'object' && payload !== null) {
        var singular = type.typeKey;
        var plural = Ember.String.pluralize(type.typeKey);
        var results = payload[singular] || payload[plural];
        if (results && results.length > 0) {
          return payload;
        }
      }
      throw new Error('Not found: type "' + type.typeKey +
        '" with id "' + id + '"');
    });
  },

  createRecord: function(store, type, record) {
    this._init(type);
    var data = this._recordToData(store, type, record);
    return this.db.rel.save(type.typeKey, data);
  },

  updateRecord: function (store, type, record) {
    this._init(type);
    var data = this._recordToData(store, type, record);
    return this.db.rel.save(type.typeKey, data);
  },

  deleteRecord: function (store, type, record) {
    this._init(type);
    var data = this._recordToData(store, type, record);
    return this.db.rel.del(type.typeKey, data).then(function () {
      return ''; // ember doesn't like getting a json response of {deleted: true}
    });
  }
});
