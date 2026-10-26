import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

/**
 * Runs the real migration script against a throwaway DATA_DIR.
 *
 * Not a reimplementation: migrate.ts is a side-effect script keyed off
 * DATA_DIR, so the contract under test is the one that actually runs at boot.
 */
const repoRoot = path.resolve(__dirname, '../..');

let dir: string;

const runMigrations = () =>
  execFileSync(
    'npx',
    ['tsx', path.join(repoRoot, 'src/lib/db/migrate.ts')],
    { env: { ...process.env, DATA_DIR: dir }, cwd: repoRoot, encoding: 'utf-8' },
  );

const columns = (db: Database.Database, table: string) =>
  db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((c: any) => c.name)
    .sort();

const open = () => new Database(path.join(dir, 'data', 'db.sqlite'));

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vane-mig-'));
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  fs.cpSync(path.join(repoRoot, 'drizzle'), path.join(dir, 'drizzle'), {
    recursive: true,
  });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('migration files', () => {
  it('every file has a unique numeric prefix', () => {
    /* The runner records a migration by its prefix, so two files sharing one
     * means the second is skipped forever -- silently. */
    const prefixes = fs
      .readdirSync(path.join(repoRoot, 'drizzle'))
      .filter((f) => f.endsWith('.sql'))
      .map((f) => f.split('_')[0]);

    expect(new Set(prefixes).size).toBe(prefixes.length);
  });
});

describe('a fresh database', () => {
  it('ends with the full schema', () => {
    runMigrations();
    const db = open();

    expect(columns(db, 'messages')).toEqual(
      [
        'answerStyle',
        'backendId',
        'chatId',
        'createdAt',
        'id',
        'messageId',
        'mode',
        'model',
        'provider',
        'query',
        'responseBlocks',
        'status',
        'writerContext',
      ].sort(),
    );

    expect(columns(db, 'llm_calls')).toContain('inputTokens');
    expect(columns(db, 'llm_calls')).toContain('role');
    expect(columns(db, 'llm_calls')).toContain('kind');
    db.close();
  });

  it('records every migration it applied', () => {
    runMigrations();
    const db = open();

    const names = db
      .prepare('SELECT name FROM ran_migrations ORDER BY name')
      .all()
      .map((r: any) => r.name);

    expect(names).toContain('0003');
    expect(names).toContain('0009');
    db.close();
  });

  it('is idempotent on a second run', () => {
    runMigrations();
    const before = columns(open(), 'messages');

    expect(() => runMigrations()).not.toThrow();
    expect(columns(open(), 'messages')).toEqual(before);
  });
});

describe('a database that already ran the pre-combination migrations', () => {
  /**
   * The combined 0003 baseline replaced six files. An existing install has
   * 0003..0008 recorded, so it must skip the baseline -- which is exactly why
   * a new column cannot live only there.
   */
  /* Runs migrations with only the named files present, so a database can be
   * built up to an arbitrary point in history. */
  const runMigrationsUpTo = (prefixes: string[]) => {
    const all = fs.readdirSync(path.join(dir, 'drizzle'));
    const held: Record<string, string> = {};

    for (const f of all) {
      if (!f.endsWith('.sql')) continue;
      if (prefixes.includes(f.split('_')[0])) continue;

      const full = path.join(dir, 'drizzle', f);
      held[f] = fs.readFileSync(full, 'utf-8');
      fs.rmSync(full);
    }

    runMigrations();

    for (const [f, body] of Object.entries(held)) {
      fs.writeFileSync(path.join(dir, 'drizzle', f), body);
    }
  };

  const seedAsUpgraded = () => {
    runMigrations();

    const db = open();
    for (const n of ['0004', '0005', '0006', '0007', '0008']) {
      db.prepare('INSERT OR IGNORE INTO ran_migrations (name) VALUES (?)').run(
        n,
      );
    }
    db.close();
  };

  it('skips the combined baseline but still applies later migrations', () => {
    /* An install that predates 0009 while already carrying 0003..0008 -- the
     * shape of the live database when the rewrite feature shipped. */
    runMigrationsUpTo(['0000', '0001', '0002']);

    const db = open();
    for (const n of ['0003', '0004', '0005', '0006', '0007', '0008']) {
      db.prepare('INSERT OR IGNORE INTO ran_migrations (name) VALUES (?)').run(n);
    }
    /* Those six really did add these columns, so mirror that. */
    for (const col of ['provider', 'model', 'mode', 'answerStyle']) {
      db.exec(`ALTER TABLE messages ADD COLUMN ${col} TEXT`);
    }
    db.close();

    const output = runMigrations();

    expect(output).toMatch(/Skipping already-applied migration: 0003/);
    expect(output).toMatch(/Applied migration: 0009/);
    expect(columns(open(), 'messages')).toContain('writerContext');
  });

  it('reaches the same column set as a fresh database', () => {
    seedAsUpgraded();
    const upgraded = columns(open(), 'messages');

    fs.rmSync(path.join(dir, 'data', 'db.sqlite'));
    runMigrations();
    const fresh = columns(open(), 'messages');

    /* Column order may differ -- the baseline creates inline, the old files
     * appended -- but the set may not. */
    expect(upgraded).toEqual(fresh);
  });
});
