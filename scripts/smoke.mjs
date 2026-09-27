import assert from 'node:assert/strict';
const base = process.env.SMOKE_URL ?? 'http://127.0.0.1:3000';
for (let i = 0; i < 30; i++) {
  try {
    const response = await fetch(`${base}/ready`);
    if (response.ok) break;
  } catch {
    /* wait for startup */
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
assert.equal((await fetch(`${base}/health`)).status, 200);
assert.equal((await fetch(`${base}/ready`)).status, 200);
assert.equal((await fetch(`${base}/docs`)).status, 200);
assert.equal((await fetch(`${base}/docs/swagger-ui-bundle.js`)).status, 200);
const schema = await (await fetch(`${base}/openapi.json`)).json();
assert.ok(schema.paths['/api/v1/events']);
assert.equal((await fetch(`${base}/api/v1/endpoints`)).status, 401);
console.log(
  'Container smoke passed: liveness, readiness, Swagger assets, OpenAPI and auth',
);
