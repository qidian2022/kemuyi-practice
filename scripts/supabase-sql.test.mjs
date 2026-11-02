import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { validProgress } from '../shared/progress-schema.ts'

const alice = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const bob = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const progress = (answers = {}) => ({ version: 3, answers, favorites: [], page: 'full', full: { order: [1, 2], index: 0 }, compact: { order: [1], index: 0 }, favoriteIndex: 0, favoritePractice: null })
const migration = readFileSync(new URL('../supabase/001_progress.sql', import.meta.url), 'utf8')

test('Postgres migration enforces RLS, per-account CAS and validation without changing existing application data', async (t) => {
  const db = new PGlite()
  try {
    await db.exec(`
      CREATE ROLE anon NOLOGIN;
      CREATE ROLE authenticated NOLOGIN;
      CREATE SCHEMA auth;
      CREATE TABLE auth.users(id uuid PRIMARY KEY);
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE SQL STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid$$;
      GRANT USAGE ON SCHEMA public, auth TO anon, authenticated;
      GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated;
      INSERT INTO auth.users VALUES ('${alice}'), ('${bob}');
      CREATE TABLE public.homework_results(id integer, payload text);
      INSERT INTO public.homework_results VALUES (1, 'unchanged-student-data');
    `)
    await db.exec(migration)
    const asRole = async (role, id, action) => {
      await db.exec('BEGIN')
      try {
        await db.exec(`SET LOCAL ROLE ${role}`)
        await db.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [id || ''])
        const result = await action()
        await db.exec('COMMIT')
        return result
      } catch (error) { await db.exec('ROLLBACK'); throw error }
    }
    const save = (id, version, data) => db.query('SELECT * FROM public.kemuyi_save_progress($1, $2, $3::jsonb)', [id, version, JSON.stringify(data)])
    await t.test('anon cannot read the table or invoke the RPC', async () => {
      await assert.rejects(asRole('anon', null, () => db.query('SELECT * FROM public.kemuyi_progress')), (error) => error.code === '42501')
      await assert.rejects(asRole('anon', null, () => save(alice, 0, progress())), (error) => error.code === '42501')
    })
    await t.test('authenticated callers cannot forge owner ids or omit auth identity', async () => {
      await assert.rejects(asRole('authenticated', bob, () => save(alice, 0, progress())), /kemuyi_account_mismatch/)
      await assert.rejects(asRole('authenticated', null, () => save(alice, 0, progress())), /kemuyi_account_mismatch/)
    })
    await t.test('only a single create/update succeeds for each expected version', async () => {
      const initial = await asRole('authenticated', alice, () => save(alice, 0, progress({ 1: 'A' })))
      assert.equal(initial.rows[0].version, 1)
      await assert.rejects(asRole('authenticated', alice, () => save(alice, 0, progress({ 2: 'B' }))), /kemuyi_version_conflict/)
      await db.exec('SET ROLE authenticated')
      await db.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [alice])
      const attempts = await Promise.allSettled([
        save(alice, 1, progress({ 1: 'A', 2: 'B' })),
        save(alice, 1, progress({ 1: 'B', 2: 'A' })),
      ])
      await db.exec('RESET ROLE')
      await db.query("SELECT set_config('request.jwt.claim.sub', '', false)")
      assert.equal(attempts.filter(({ status }) => status === 'fulfilled').length, 1)
      assert.equal(attempts.filter(({ status }) => status === 'rejected').length, 1)
      const next = attempts.find(({ status }) => status === 'fulfilled').value
      assert.equal(next.rows[0].version, 2)
      await assert.rejects(asRole('authenticated', alice, () => save(alice, 1, progress({}))), /kemuyi_version_conflict/)
    })
    await t.test('RLS isolates reads and authenticated has no direct INSERT UPDATE DELETE access', async () => {
      const own = await asRole('authenticated', alice, () => db.query('SELECT * FROM public.kemuyi_progress'))
      assert.equal(own.rows.length, 1)
      assert.deepEqual(own.rows[0].data.answers, { 1: 'A', 2: 'B' })
      const other = await asRole('authenticated', bob, () => db.query('SELECT * FROM public.kemuyi_progress'))
      assert.deepEqual(other.rows, [])
      await assert.rejects(asRole('authenticated', alice, () => db.query('UPDATE public.kemuyi_progress SET version=99')), (error) => error.code === '42501')
      await assert.rejects(asRole('authenticated', alice, () => db.query('DELETE FROM public.kemuyi_progress')), (error) => error.code === '42501')
      await assert.rejects(asRole('authenticated', bob, () => db.query('INSERT INTO public.kemuyi_progress VALUES ($1, 1, $2::jsonb, now())', [bob, JSON.stringify(progress())])), (error) => error.code === '42501')
      const created = await asRole('authenticated', bob, () => save(bob, 0, progress({ 2: 'A' })))
      assert.equal(created.rows[0].version, 1)
      const stillAlice = await asRole('authenticated', alice, () => db.query('SELECT version FROM public.kemuyi_progress'))
      assert.equal(stillAlice.rows[0].version, 2)
    })
    await t.test('JSON schema agrees with the browser on invalid and oversized snapshots', async () => {
      const invalid = [null, {}, { ...progress(), answers: { 1: ['A'] } }, { ...progress(), page: ['full'] },
        { ...progress(), favorites: [1, 1] }, { ...progress(), answers: { 100001: 'A' } },
        { ...progress(), full: { order: [1], index: -1 } }, { ...progress(), favoritePractice: {} }]
      for (const data of invalid) {
        assert.equal(validProgress(data), false)
        await assert.rejects(asRole('authenticated', alice, () => save(alice, 2, data)), /kemuyi_invalid_progress/)
      }
      await assert.rejects(asRole('authenticated', alice, () => save(alice, 2, { ...progress(), extra: 'x'.repeat(256001) })), /kemuyi_invalid_progress/)
      await assert.rejects(asRole('authenticated', alice, () => save(alice, -1, progress())), /kemuyi_invalid_progress/)
    })
    await t.test('reapplying the migration preserves both progress and pre-existing student data', async () => {
      await db.exec(migration)
      assert.equal((await db.query('SELECT count(*)::integer AS n FROM public.kemuyi_progress')).rows[0].n, 2)
      assert.equal((await db.query('SELECT payload FROM public.homework_results WHERE id=1')).rows[0].payload, 'unchanged-student-data')
    })
  } finally { await db.close() }
})
