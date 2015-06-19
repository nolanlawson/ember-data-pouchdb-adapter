import { module, test } from 'qunit';
import startApp from '../../helpers/start-app';

import Ember from 'ember';
/* globals PouchDB */

var App;

/*
 * Tests basic CRUD behavior for an app using the ember-pouch adapter.
 */

module('adapter:pouch [integration]', {
  beforeEach: function (assert) {
    var done = assert.async();

    // TODO: do this in a way that doesn't require duplicating the name of the
    // test database here and in dummy/app/adapters/application.js. Importing
    // the adapter directly doesn't work because of what seems like a resolver
    // issue.
    (new PouchDB('ember-pouch-test')).destroy().then(() => {
      App = startApp();
      var bootPromise;
      Ember.run(() => {
        if (App.boot) {
          App.advanceReadiness();
          bootPromise = App.boot();
        } else {
          bootPromise = Ember.RSVP.Promise.resolve();
        }
      });
      return bootPromise;
    }).then(() => {
      done();
    });
  },

  afterEach: function (assert) {
    Ember.run(App, 'destroy');
  }
});

function db() {
  return adapter().get('db');
}

function adapter() {
  // the default adapter in the dummy app is an ember-pouch adapter
  return App.__container__.lookup('adapter:application');
}

function store() {
  return App.__container__.lookup('store:main');
}

test('can find all', function (assert) {
  assert.expect(3);

  var done = assert.async();
  Ember.RSVP.Promise.resolve().then(() => {
    return db().bulkDocs([
      { _id: 'tacoSoup_2_A', data: { flavor: 'al pastor' } },
      { _id: 'tacoSoup_2_B', data: { flavor: 'black bean' } },
      { _id: 'burritoShake_2_X', data: { consistency: 'smooth' } }
    ]);
  }).then(() => {
    return store().find('taco-soup');
  }).then((found) => {
    assert.equal(found.get('length'), 2, 'should have found the two taco soup items only');
    assert.deepEqual(found.mapBy('id'), ['A', 'B'],
      'should have extracted the IDs correctly');
    assert.deepEqual(found.mapBy('flavor'), ['al pastor', 'black bean'],
      'should have extracted the attributes also');
    done();
  }).catch((error) => {
    console.error('error in test', error);
    assert.ok(false, 'error in test:' + error);
    done();
  });
});

test('can find one', function (assert) {
  assert.expect(2);

  var done = assert.async();
  Ember.RSVP.Promise.resolve().then(() => {
    return db().bulkDocs([
      { _id: 'tacoSoup_2_C', data: { flavor: 'al pastor' } },
      { _id: 'tacoSoup_2_D', data: { flavor: 'black bean' } },
    ]);
  }).then(() => {
    return store().find('taco-soup', 'D');
  }).then((found) => {
    assert.equal(found.get('id'), 'D',
      'should have found the requested item');
    assert.deepEqual(found.get('flavor'), 'black bean',
      'should have extracted the attributes also');
    done();
  }).catch((error) => {
    console.error('error in test', error);
    assert.ok(false, 'error in test:' + error);
    done();
  });
});

test('create a new record', function (assert) {
  assert.expect(1);

  var done = assert.async();
  Ember.RSVP.Promise.resolve().then(() => {
    var newSoup = store().createRecord('taco-soup', { id: 'E', flavor: 'balsamic' });
    return newSoup.save();
  }).then((saved) => {
    return db().get('tacoSoup_2_E');
  }).then((newDoc) => {
    assert.equal(newDoc.data.flavor, 'balsamic', 'should have saved the attribute');
    done();
  }).catch((error) => {
    console.error('error in test', error);
    assert.ok(false, 'error in test:' + error);
    done();
  });
});

test('update an existing record', function (assert) {
  assert.expect(1);

  var done = assert.async();
  Ember.RSVP.Promise.resolve().then(() => {
    return db().bulkDocs([
      { _id: 'tacoSoup_2_C', data: { flavor: 'al pastor' } },
      { _id: 'tacoSoup_2_D', data: { flavor: 'black bean' } },
    ]);
  }).then(() => {
    return store().find('taco-soup', 'C');
  }).then((found) => {
    found.set('flavor', 'pork');
    return found.save();
  }).then((saved) => {
    return db().get('tacoSoup_2_C');
  }).then((updatedDoc) => {
    assert.equal(updatedDoc.data.flavor, 'pork', 'should have updated the attribute');
    done();
  }).catch((error) => {
    console.error('error in test', error);
    assert.ok(false, 'error in test:' + error);
    done();
  });
});

test('delete an existing record', function (assert) {
  assert.expect(1);

  var done = assert.async();
  Ember.RSVP.Promise.resolve().then(() => {
    return db().bulkDocs([
      { _id: 'tacoSoup_2_C', data: { flavor: 'al pastor' } },
      { _id: 'tacoSoup_2_D', data: { flavor: 'black bean' } },
    ]);
  }).then(() => {
    return store().find('taco-soup', 'C');
  }).then((found) => {
    return found.destroyRecord();
  }).then(() => {
    return db().get('tacoSoup_2_C');
  }).then((doc) => {
    assert.ok(!doc, 'document should no longer exist');
  }, (result) => {
    assert.equal(result.status, 404, 'document should no longer exist');
    done();
  }).catch((error) => {
    console.error('error in test', error);
    assert.ok(false, 'error in test:' + error);
    done();
  });
});
