import type Database from 'better-sqlite3';
import { Hono } from 'hono';
import { z } from 'zod';
import { TaskStore } from '../chat/TaskStore.js';
import { TabStore } from '../store/TabStore.js';

const NewSchema = z.object({
  request: z.string().trim().min(1),
  criteria: z.string().trim().min(1).optional(),
  next_step: z.string().trim().min(1).optional(),
});

/**
 * REST for `muxpad task` — see chat/TaskStore.ts for what a task is and
 * chat/task-continue.ts for what muxpad does with one.
 *
 * Mounted under /api/tabs because a task belongs to a CHAT, exactly like a
 * card: the CLI passes `MUXPAD_TAB_ID` from the pane environment, so an agent
 * declaring its own task names no id at all.
 *
 * EVERY WRITE HERE IS THE AGENT'S OWN. There is no endpoint that marks a task
 * done on the agent's behalf, and no reviewer anywhere that second-guesses it.
 * That is the design, not an omission — the judgement about whether work is
 * finished needs the conversation, and the conversation is the agent.
 */
export function tasksRoutes(deps: { db: Database.Database }): Hono {
  const app = new Hono();
  const tasks = new TaskStore(deps.db);
  const tabs = new TabStore(deps.db);

  const bad = (message: string) => ({ error: { code: 'bad_request' as const, message } });
  const haveTab = (tabId: string) => tabs.getById(tabId) !== null;

  app.get('/:tabId/tasks', (c) => {
    const tabId = c.req.param('tabId');
    if (!haveTab(tabId)) return c.json(bad('no such chat'), 404);
    return c.json({ open: tasks.openFor(tabId), tasks: tasks.listFor(tabId) });
  });

  app.post('/:tabId/tasks', async (c) => {
    const tabId = c.req.param('tabId');
    if (!haveTab(tabId)) return c.json(bad('no such chat'), 404);
    const parsed = NewSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json(bad('body must be {request, criteria?, next_step?}'), 400);
    // A SECOND open task supersedes the first rather than being refused.
    //
    // Refusing was the first instinct and it is wrong: the agent would be
    // stuck with a stale record it cannot replace, and the honest reading of
    // "here is my task" arriving twice is that the job changed. Closing the
    // old one as superseded keeps the one-open-task invariant (TaskStore.openFor
    // documents why there is only ever one) and keeps the history readable.
    const prior = tasks.openFor(tabId);
    if (prior) tasks.finish(prior.id, 'superseded by a newer task in this chat');
    const task = tasks.create(tabId, {
      request: parsed.data.request,
      ...(parsed.data.criteria ? { criteria: parsed.data.criteria } : {}),
      ...(parsed.data.next_step ? { next_step: parsed.data.next_step } : {}),
    });
    return c.json({ task, ...(prior ? { superseded: prior.id } : {}) }, 201);
  });

  const PatchSchema = z.object({
    state: z.enum(['done', 'blocked']).optional(),
    next_step: z.string().trim().min(1).optional(),
    evidence: z.string().trim().min(1).optional(),
  });

  app.patch('/:tabId/tasks/:id', async (c) => {
    const tabId = c.req.param('tabId');
    if (!haveTab(tabId)) return c.json(bad('no such chat'), 404);
    const task = tasks.get(c.req.param('id'));
    // The tab check is not ceremony: a task id from another chat would
    // otherwise let any pane close any other pane's work.
    if (!task || task.tab_id !== tabId) return c.json(bad('no such task in this chat'), 404);
    const parsed = PatchSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json(bad('body must be {state?, next_step?, evidence?}'), 400);
    const { state, next_step, evidence } = parsed.data;
    if (state === 'done') {
      // Evidence is required HERE rather than in the schema so the message can
      // say why. "Done" with nothing to point at is the exact failure this
      // feature exists for: on 11/09 a chat declared completion and a review
      // the next morning found six defects still open.
      if (!evidence) return c.json(bad('`done` needs --evidence: what proves it'), 400);
      tasks.finish(task.id, evidence);
    } else if (state === 'blocked') {
      if (!evidence) return c.json(bad('`block` needs --why: what the user has to settle'), 400);
      tasks.block(task.id, evidence);
    } else if (next_step) {
      tasks.setNextStep(task.id, next_step);
    } else {
      return c.json(bad('nothing to change'), 400);
    }
    return c.json({ task: tasks.get(task.id) });
  });

  return app;
}
