import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SkillRegistry } from '../dist/skills.js';
import { SessionStore } from '../dist/session-store.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'mirror-skills-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (directory, id, text) => {
    const folder = join(root, directory, id); mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'SKILL.md'), text);
  };
  return { root, put };
}
test('Skills discover, refresh changed content, override and fall back after deletion', t => {
  const { root, put } = fixture(t); put('skills', 'brief', 'first');
  const registry = new SkillRegistry(root);
  const first = registry.select('/brief task');
  put('skills', 'brief', 'second');
  assert.equal(first.instructions, 'first');
  assert.notEqual(registry.select('/brief task').version, first.version);
  put('.data/skills', 'brief', 'local');
  assert.equal(registry.select('/brief task').source, '.data/skills/brief/SKILL.md');
  put('skills', 'other', 'newly discovered');
  assert.equal(registry.select('/other task').instructions, 'newly discovered');
  rmSync(join(root, '.data/skills/brief'), { recursive: true });
  assert.equal(registry.select('/brief task').instructions, 'second');
  rmSync(join(root, 'skills/brief'), { recursive: true });
  assert.throws(() => registry.select('/brief task'), { code: 'SKILL_NOT_FOUND' });
});
test('Skills validate atomically, expose errors and recover after repair', t => {
  const { root, put } = fixture(t); put('skills', 'brief', 'valid');
  const registry = new SkillRegistry(root);
  put('skills', 'brief', '');
  assert.throws(() => registry.select('/brief task'), { code: 'SKILL_INVALID' });
  assert.equal(registry.overview().skills.length, 0);
  assert.equal(registry.overview().errors[0].id, "brief");
  put('skills', 'brief', 'repaired');
  assert.equal(registry.select('/brief task').instructions, 'repaired');
  assert.equal(registry.overview().error, null);
  assert.throws(() => registry.select('/brief'), { code: 'SKILL_INPUT_REQUIRED' });
  put('skills', 'team', 'cannot shadow coordinator');
  assert.ok(registry.refresh().errors.length);
});
test('Skills reject links and oversized instructions and preserve research aliases', t => {
  const { root, put } = fixture(t); put('skills', 'multi-hop-research-v2', 'research');
  const registry = new SkillRegistry(root);
  assert.equal(registry.select('/research2 question').id, 'multi-hop-research-v2');
  symlinkSync(join(root, 'skills/multi-hop-research-v2'), join(root, 'skills/linked'));
  assert.ok(registry.refresh().errors.length);
  rmSync(join(root, 'skills/linked'));
  put('skills', 'huge', 'x'.repeat(8001));
  assert.ok(registry.refresh().errors.length);
});
test('Run Skill snapshots survive file changes and database reopen, including no Skill', t => {
  const { root, put } = fixture(t); put('skills', 'brief', 'original');
  const registry = new SkillRegistry(root);
  const path = join(root, 'runs.sqlite');
  let store = new SessionStore(path);
  try {
    const session = store.create();
    const run = store.accept(session.id, 'snapshot', '/brief task');
    store.selectRunSkill(run.id, () => registry.select(run.input));
    put('skills', 'brief', 'changed');
    store.close(); store = new SessionStore(path);
    assert.equal(store.selectRunSkill(run.id, () => { throw Error('must not reselect'); }).instructions, 'original');
    const another = store.accept(session.id, 'next', '/brief task');
    assert.equal(store.selectRunSkill(another.id, () => registry.select(another.input)).instructions, 'changed');
    const plain = store.accept(session.id, 'plain', 'hello');
    assert.equal(store.selectRunSkill(plain.id, () => undefined), undefined);
    assert.equal(store.selectRunSkill(plain.id, () => { throw Error('must pin none'); }), undefined);
  } finally { store.close(); }
});

test('Coordinator pins active instructions while the next queued Run discovers the new version', async t => {
  const { RunCoordinator } = await import('../dist/run-coordinator.js');
  const { root, put } = fixture(t); put('skills', 'brief', 'version one');
  const skills = new SkillRegistry(root);
  const store = new SessionStore(':memory:');
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let started;
  const entered = new Promise(resolve => { started = resolve; });
  let calls = 0;
  const runtime = { info: { kind: 'demo', label: 'controlled' }, async *stream(input) {
    if (++calls === 1) { started(); await gate; }
    yield input.skillInstruction;
  } };
  const coordinator = new RunCoordinator(store, runtime, () => {}, 5000, undefined, 120000, skills);
  try {
    const session = store.create();
    const first = coordinator.accept(session.id, 'first', '/brief task');
    await entered;
    const second = coordinator.accept(session.id, 'second', '/brief task');
    put('skills', 'brief', 'version two'); skills.refresh();
    release();
    for (let i = 0; i < 200 && store.getRun(second.id).status !== 'completed'; i++) await new Promise(r => setTimeout(r, 5));
    assert.equal(store.getRun(first.id).output, 'version one');
    assert.equal(store.getRun(second.id).output, 'version two');
    assert.equal(JSON.parse(store.getRun(second.id).contextTrace).skillSource, 'skills/brief/SKILL.md');
  } finally { release(); await coordinator.shutdown(); store.close(); }
});

test('broken Skill isolates failures, ordinary chat and unrelated commands continue', t => {
  const { root, put } = fixture(t);
  put('skills', 'broken', ''); put('skills', 'healthy', 'good');
  const registry = new SkillRegistry(root);
  assert.equal(registry.select('hello'), undefined);
  assert.equal(registry.select('/healthy task').instructions, 'good');
  assert.throws(() => registry.select('/broken task'), { code: 'SKILL_INVALID' });
  assert.throws(() => registry.select('/typo task'), { code: 'SKILL_NOT_FOUND' });
  put('.data/skills', 'healthy', '');
  assert.throws(() => registry.select('/healthy task'), { code: 'SKILL_INVALID' });
  put('skills', 'constructor', 'safe alias');
  assert.equal(registry.select('/constructor task').command, '/constructor');
});
