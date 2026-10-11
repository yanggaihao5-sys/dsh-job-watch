/**
 * Kernel tests for dsh-job-watch: the pure functions that decide what a
 * conversation's colour MEANS. They are the part worth testing without a GUI —
 * parsing a provider's listing, folding a raw STAT into a colour, deciding
 * whether a message is a real prompt, and refusing to invent a finish time.
 *
 *   node --test test/kernel.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { parseListing, foldState, isRealPrompt, recommendFinish } from '../lib/index.js'

const SCHEDULER_PATTERN = '^\\s*(?<id>\\d+)\\s+\\S+\\s+(?<stat>\\w+)\\s+(?<name>\\S+)'

test('parseListing: header lines and noise are ignored, ids and STATs are kept', () => {
  const stdout = [
    'JOBID USER STAT JOB_NAME SUBMIT_TIME',
    '40217 alice RUN  train-a Aug 12 09:31',
    '40218 alice DONE eval-b  Aug 12 09:31',
    'a warning banner that matches nothing',
  ].join('\n')
  const jobs = parseListing(stdout, SCHEDULER_PATTERN)
  assert.equal(jobs.size, 2)
  assert.deepEqual(jobs.get('40217'), { stat: 'RUN', name: 'train-a' })
  assert.equal(jobs.get('40218').stat, 'DONE')
})

test('parseListing: a provider with no STAT column still yields the id', () => {
  const jobs = parseListing('train-a\neval-b\n', '^(?<id>[A-Za-z0-9_.-]+)$')
  assert.deepEqual([...jobs.keys()], ['train-a', 'eval-b'])
  assert.equal(jobs.get('train-a').stat, undefined)
})

test('parseListing: ANSI colour codes do not break matching', () => {
  const jobs = parseListing('\u001b[32m40217 alice RUN train-a\u001b[0m', SCHEDULER_PATTERN)
  assert.equal(jobs.get('40217').stat, 'RUN')
})

test('parseListing: a broken pattern is survivable, not fatal', () => {
  assert.equal(parseListing('anything', '([unclosed').size, 0)
})

test('foldState: RUNning states are running, terminal states are done', () => {
  assert.equal(foldState('RUN'), 'running')
  assert.equal(foldState('PEND'), 'running')
  assert.equal(foldState('DONE'), 'done')
  assert.equal(foldState('EXIT'), 'done')
  assert.equal(foldState('WEIRD'), 'unknown')
})

test('foldState: no STAT at all means running — being listed is the evidence', () => {
  assert.equal(foldState(undefined), 'running')
  assert.equal(foldState(''), 'running')
})

test('foldState: a provider may override the vocabulary', () => {
  const provider = { runningStates: ['ALIVE'], doneStates: ['GONE'] }
  assert.equal(foldState('ALIVE', provider), 'running')
  assert.equal(foldState('GONE', provider), 'done')
  assert.equal(foldState('RUN', provider), 'unknown')
})

test('isRealPrompt: injected context does not count as the user speaking', () => {
  assert.equal(isRealPrompt('<system-reminder>anything</system-reminder>'), false)
  assert.equal(isRealPrompt('Current runtime context. This snapshot supersedes…'), false)
  assert.equal(isRealPrompt('   '), false)
  assert.equal(isRealPrompt(''), false)
  assert.equal(isRealPrompt({ content: [{ type: 'text', text: '跑完了吗' }] }), true)
})

test('recommendFinish: a finished job says so, and says what to do', () => {
  const text = recommendFinish({ jobId: '1', provider: 'hpc', state: 'done', stat: 'DONE' }, Date.now())
  assert.match(text, /finished \(DONE\)/)
  assert.match(text, /analyse it now/)
})

test('recommendFinish: with an ETA it does the arithmetic instead of guessing', () => {
  const now = Date.now()
  const job = { jobId: '1', provider: 'hpc', state: 'running', stat: 'RUN', registeredAt: now, etaMinutes: 120 }
  const text = recommendFinish(job, now)
  assert.match(text, /expected to finish/)
  assert.match(text, /about 120 min left/)
  assert.match(text, /registration time \+ the 120 min ETA/)
})

test('recommendFinish: an ETA that has already elapsed is reported as overdue, not as done', () => {
  const now = Date.now()
  const job = { jobId: '1', provider: 'hpc', state: 'running', stat: 'RUN', registeredAt: now - 600000, etaMinutes: 5 }
  const text = recommendFinish(job, now)
  assert.match(text, /should already have finished/)
  assert.match(text, /still reports it running/)
})

test('recommendFinish: without an ETA it refuses to invent a time and names the way to measure it', () => {
  const text = recommendFinish({ jobId: '77', provider: 'lab', state: 'running', registeredAt: Date.now() }, Date.now())
  assert.match(text, /no reliable estimate/)
  assert.match(text, /elapsed-time column|progress line/)
})

test('recommendFinish: an unknown id is not painted as running', () => {
  const text = recommendFinish({ jobId: '9', provider: 'hpc', state: 'unknown', registeredAt: Date.now() }, Date.now())
  assert.match(text, /not found by its provider/)
})
