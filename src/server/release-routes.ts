import { Router } from 'express';
import { ReleaseStore } from './release';

export { ReleaseStore } from './release';

// REST surface for the multi-consumer release workflow. All gate decisions
// are computed server-side; the client only displays server verdicts and
// submits opaque preview tokens to confirm.
export function releaseRouter(store: ReleaseStore): Router {
  const router = Router();

  router.get('/consumers', (_req, res) => {
    res.json(store.listConsumers());
  });

  router.post('/consumers', (req, res) => {
    const out = store.createConsumer(req.body ?? {});
    if (!out.ok) {
      if (out.status === 400) return res.status(400).json({ error: 'invalid_consumer', issues: out.issues });
      return res.status(out.status).json({ error: 'conflict' });
    }
    res.status(201).json(out.detail);
  });

  router.get('/consumers/:id', (req, res) => {
    const detail = store.getConsumer(req.params.id);
    if (!detail) return res.status(404).json({ error: 'consumer_not_found' });
    res.set('ETag', String(detail.revision)).json(detail);
  });

  router.put('/consumers/:id', (req, res) => {
    const out = store.updateConsumer(req.params.id, req.body ?? {});
    if (!out.ok) {
      if (out.status === 404) return res.status(404).json({ error: 'consumer_not_found' });
      if (out.status === 400) return res.status(400).json({ error: 'invalid_consumer', issues: out.issues });
      return res.status(409).json({ error: 'revision_conflict', current: out.current });
    }
    res.json(out.detail);
  });

  router.delete('/consumers/:id', (req, res) => {
    const out = store.deleteConsumer(req.params.id, req.body?.expectedRevision ?? req.query.revision);
    if (out === false) return res.status(404).json({ error: 'consumer_not_found' });
    if (out === 409) return res.status(409).json({ error: 'revision_conflict' });
    res.status(204).end();
  });

  router.post('/preview', (req, res) => {
    const out = store.preview(req.body ?? {});
    if (!out.ok) return res.status(400).json({ error: 'invalid_producer', issues: out.issues });
    res.json(out.preview);
  });

  router.post('/releases', (req, res) => {
    const token = typeof req.body?.token === 'string' ? req.body.token : '';
    const out = store.confirm(token);
    if (out.ok) return res.status(201).json(out.record);
    if (out.status === 404) return res.status(404).json({ error: 'preview_not_found' });
    if (out.status === 422) return res.status(422).json(out.body);
    return res.status(409).json(out.body);
  });

  router.get('/releases', (_req, res) => {
    res.json(store.listReleases());
  });

  router.get('/releases/:id', (req, res) => {
    const record = store.getRelease(req.params.id);
    if (!record) return res.status(404).json({ error: 'release_not_found' });
    res.json(record);
  });

  return router;
}
