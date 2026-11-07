// Durable checkpoints contain parcel data only; platform credentials stay in the account vault.
export function createLogisticsQueue({ store, now }) {
  store.db.exec(`CREATE TABLE IF NOT EXISTS sync_logistics_tasks (
    job_id TEXT NOT NULL, task_key TEXT NOT NULL, state TEXT NOT NULL, input TEXT NOT NULL,
    result TEXT, attempts INTEGER NOT NULL DEFAULT 0, duration_ms INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(job_id,task_key));`);
  const progress = id => {
    return store.db.prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(state='completed'),0) AS completed,
      COALESCE(SUM(state='running'),0) AS active, COALESCE(SUM(attempts),0) AS attempts,
      COALESCE(SUM(duration_ms),0) AS durationMs FROM sync_logistics_tasks WHERE job_id=? AND state<>'skipped'`).get(id);
  };
  return {
    progress,
    clear(id) { store.db.prepare('DELETE FROM sync_logistics_tasks WHERE job_id=?').run(id); },
    async run(record, items, worker, { stage, concurrency = 2, key, onResult = () => {} }, { valid, changed, relevant = () => true }) {
      const jobId = record.job.id;
      if (record.job.continuation) {
        const supplied = new Set(items.map(key)), prefix = `${stage}:`;
        for (const previous of store.db.prepare('SELECT * FROM sync_logistics_tasks WHERE job_id=? AND substr(task_key,1,?)=?').all(jobId, prefix.length, prefix)) {
          const item = JSON.parse(previous.input);
          if (!supplied.has(key(item))) {
            if (relevant(item)) { items.push(item); supplied.add(key(item)); }
            else store.db.prepare("UPDATE sync_logistics_tasks SET state='skipped' WHERE job_id=? AND task_key=?").run(jobId, previous.task_key);
          }
        }
      }
      const keys = items.map(item => `${stage}:${key(item)}`);
      store.transaction(() => {
        for (let i = 0; i < items.length; i++) store.db.prepare(`INSERT OR IGNORE INTO sync_logistics_tasks
          (job_id,task_key,state,input) VALUES(?,?,?,?)`).run(jobId, keys[i], 'queued', JSON.stringify(items[i]));
      });
      changed(progress(jobId));
      const results = [];
      let next = 0, failure;
      // Session-mutating stages request one worker; throttled jobs also resume with one.
      const width = Math.min(record.job.throttled ? 1 : concurrency, 2, items.length);
      await Promise.all(Array.from({ length: width }, async () => {
        while (!failure && next < items.length) {
          const index = next++, taskKey = keys[index];
          try {
            valid();
            const previous = store.db.prepare('SELECT * FROM sync_logistics_tasks WHERE job_id=? AND task_key=?').get(jobId, taskKey);
            if (previous.state === 'completed') results[index] = JSON.parse(previous.result);
            else {
              const started = performance.now();
              store.transaction(() => {
                store.db.prepare("UPDATE sync_logistics_tasks SET state='running',attempts=attempts+1 WHERE job_id=? AND task_key=?").run(jobId, taskKey);
                changed(progress(jobId));
              });
              try {
                results[index] = await worker(items[index], index);
                valid();
                let published;
                store.transaction(() => {
                  store.db.prepare("UPDATE sync_logistics_tasks SET state='completed',result=?,duration_ms=duration_ms+? WHERE job_id=? AND task_key=?")
                    .run(JSON.stringify(results[index] ?? null), Math.round(performance.now() - started), jobId, taskKey);
                  published = onResult(results[index], items[index], index);
                  changed(progress(jobId));
                });
                await published;
                continue;
              } catch (error) {
                store.db.prepare("UPDATE sync_logistics_tasks SET state='queued',duration_ms=duration_ms+? WHERE job_id=? AND task_key=?")
                  .run(Math.round(performance.now() - started), jobId, taskKey);
                // The account runner drains peers, then resumes all unfinished items after backoff.
                error.logisticsRetryable = ['UPSTREAM_ERROR', 'UPSTREAM_RATE_LIMITED', 'UPSTREAM_BLOCKED'].includes(error.code)
                  || ['TimeoutError', 'AbortError', 'TypeError'].includes(error.name);
                throw error;
              }
            }
            await onResult(results[index], items[index], index);
            changed(progress(jobId));
          } catch (error) { failure ||= error; }
        }
      }));
      if (failure) throw failure;
      return results;
    },
  };
}
