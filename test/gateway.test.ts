/** The built-in postgres-readonly gateway's syntactic guard (defense 3 of 3; the role and the READ ONLY tx are live-only). */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { assertReadOnly } from "../src/gateways/postgres-readonly.js";

test("read shapes pass: select/with/explain/show, comments stripped", () => {
  for (const sql of [
    "select 1",
    "  SELECT count(*) from core_user",
    "with x as (select 1) select * from x",
    "explain select * from t",
    "show server_version",
    "-- a comment\nselect 2",
    "select 'a;b' as tricky", // a semicolon INSIDE a string is not a second statement
  ]) {
    assert.doesNotThrow(() => assertReadOnly(sql), sql);
  }
});

test("write shapes and multi-statements are refused", () => {
  for (const sql of [
    "update core_user set id=id",
    "delete from t",
    "insert into t values (1)",
    "drop table t",
    "create temp table x(a int)",
    "truncate t",
    "grant all on t to public",
    "select 1; delete from t", // piggyback
    "-- select\ndelete from t", // a comment cannot launder the first keyword
  ]) {
    assert.throws(() => assertReadOnly(sql), undefined, sql);
  }
});
