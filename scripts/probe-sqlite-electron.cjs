const Database = require("better-sqlite3");
const db = new Database(":memory:");
db.exec("CREATE TABLE t (id INTEGER); INSERT INTO t VALUES (1);");
const row = db.prepare("SELECT id FROM t").get();
console.log("SQLITE_OK", row.id, "modules", process.versions.modules, "electron", process.versions.electron);
db.close();
process.exit(0);
