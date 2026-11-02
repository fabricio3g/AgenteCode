import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from '../../main/sqlite.ts';

test('SQLite supports named search bindings, nested migrations and rollback', () => {
  const db = new Database(':memory:');
  try {
    db.exec('CREATE TABLE records (id INTEGER PRIMARY KEY, name TEXT)');
    const insert = db.transaction((name) => db.prepare('INSERT INTO records (name) VALUES (?)').run(name));
    db.transaction(() => { insert('one'); insert('two'); })();
    assert.deepEqual(db.prepare('SELECT name FROM records WHERE name = @name').all({ name: 'two' }), [{ name: 'two' }]);
    assert.throws(db.transaction(() => { insert('rolled back'); throw new Error('abort migration'); }), /abort migration/);
    assert.equal(db.prepare('SELECT count(*) AS count FROM records').get().count, 2);
    db.transaction(() => {
      assert.throws(db.transaction(() => { insert('inner rollback'); throw new Error('inner'); }));
      insert('three');
    })();
    assert.equal(db.prepare('SELECT count(*) AS count FROM records').get().count, 3);
  } finally { db.close(); }
});
