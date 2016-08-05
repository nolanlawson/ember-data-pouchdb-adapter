import { moduleFor, test } from 'ember-qunit';

let testSerializedData = {
  'test.txt': {
    content_type: 'text/plain',
    data: 'hello world!'
  }
};

let testDeserializedData = [
  {
    name: 'test.txt',
    content_type: 'text/plain',
    data: 'hello world!'
  }
];

moduleFor('transform:attachment', 'Unit | Transform | attachment', {});

test('it serializes an attachment', function(assert) {
  let transform = this.subject();
  assert.equal(transform.serialize(null), null);
  assert.equal(transform.serialize(undefined), null);

  let serializedData = transform.serialize(testDeserializedData);
  let name = testDeserializedData[0].name;

  assert.equal(serializedData[name].content_type, testSerializedData[name].content_type);
  assert.equal(serializedData[name].data, testSerializedData[name].data);

});

test('it deserializes an attachment', function(assert) {
  let transform = this.subject();
  assert.equal(transform.deserialize(null), null);
  assert.equal(transform.deserialize(undefined), null);

  let deserializedData = transform.deserialize(testSerializedData);

  assert.equal(deserializedData[0].name, testDeserializedData[0].name);
  assert.equal(deserializedData[0].content_type, testDeserializedData[0].content_type);
  assert.equal(deserializedData[0].data, testDeserializedData[0].data);

});
