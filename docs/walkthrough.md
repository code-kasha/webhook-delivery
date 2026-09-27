# Reviewer walkthrough

Use a fresh local installation from the README, with `ALLOW_PRIVATE_DESTINATIONS=true` and a private CLI-created admin token. For Compose, apply environment changes with `docker compose up -d`. Keep the encryption key unchanged across restarts. These examples use only fictional data.

Open `/docs`, choose **Authorize**, and enter the token alone (Swagger adds `Bearer`). The registration URL shown in the schema is a fictional placeholder; replace it with a reachable local receiver. The screenshot in the README is an actual unauthenticated local Swagger view, not a hosted demo.

The commands below use PowerShell. Keep this terminal open so the returned IDs remain available. Store the CLI token in `$env:WEBHOOK_API_KEY` locally; do not paste it into shared logs.

```powershell
$base = 'http://127.0.0.1:3000/api/v1'
$headers = @{ Authorization = "Bearer $env:WEBHOOK_API_KEY" }
# Native API: loopback. Docker Desktop API: http://host.docker.internal:4000
$receiverUrl = 'http://127.0.0.1:4000'
$endpoint = Invoke-RestMethod "$base/endpoints" -Method Post -Headers $headers -ContentType 'application/json' -Body (@{ url = $receiverUrl; event_types = @('lead.created') } | ConvertTo-Json)
$endpointId = $endpoint.id
```

In a second terminal, set `WEBHOOK_SECRET` to `$endpoint.secret` and run `pnpm receiver`. For Docker Desktop also set `RECEIVER_HOST=0.0.0.0`; see [receiver setup](receiver.md). The signing secret is returned once and differs from the API key.

## Publish and inspect

```powershell
$publishHeaders = $headers.Clone()
$publishHeaders['Idempotency-Key'] = 'fictional-review-001'
$body = '{"type":"lead.created","data":{"name":"Fictional Customer"}}'
$event = Invoke-RestMethod "$base/events" -Method Post -Headers $publishHeaders -ContentType 'application/json' -Body $body
Invoke-RestMethod "$base/deliveries?event_id=$($event.id)" -Headers $headers
Invoke-RestMethod "$base/attempts?event_id=$($event.id)" -Headers $headers
```

Poll the two GETs until the delivery is `succeeded` and the attempt has `response_code: 204`. Publishing returns 202 before delivery finishes. Repeat the POST unchanged: the same event ID returns with `duplicate:true`. Use a new idempotency key for every new event below.

## Rotate, suspend and resume

```powershell
$rotation = Invoke-RestMethod "$base/endpoints/$endpointId/rotate-secret" -Method Post -Headers $headers
# Stop the receiver and restart it with WEBHOOK_SECRET=$rotation.secret.
# During the 24-hour overlap, either old or new secret verifies deliveries.
Invoke-RestMethod "$base/endpoints/$endpointId" -Method Patch -Headers $headers -ContentType 'application/json' -Body '{"enabled":false}'
$publishHeaders['Idempotency-Key'] = 'fictional-review-paused'
$queued = Invoke-RestMethod "$base/events" -Method Post -Headers $publishHeaders -ContentType 'application/json' -Body $body
Invoke-RestMethod "$base/deliveries?event_id=$($queued.id)" -Headers $headers
```

The new delivery remains pending with zero attempts. Restart the native API with the same `.env`, or run `docker compose down` followed by `docker compose up -d` (retain the volume). Query the original event and attempts again; they survive. Resume and poll the queued event until it succeeds:

```powershell
Invoke-RestMethod "$base/endpoints/$endpointId" -Method Patch -Headers $headers -ContentType 'application/json' -Body '{"enabled":true}'
```

Re-enabling clears automatic pause and the failure streak too. A second rotation during the overlap returns 409. Already claimed HTTP work can finish after disabling.

## Observe failures and replay

Stop the receiver, publish a new event with `Idempotency-Key: fictional-review-failure`, and inspect its attempts. Connection errors count as failures. With a controlled receiver returning 503, attempts instead record `http_status` and response code 503. Both follow the same retry policy.

```powershell
$publishHeaders['Idempotency-Key'] = 'fictional-review-failure'
$failureEvent = Invoke-RestMethod "$base/events" -Method Post -Headers $publishHeaders -ContentType 'application/json' -Body $body
$failureEventId = $failureEvent.id
```

After five consecutive failures, GET the endpoint: `paused` is true. The delivery has used five of eight attempts and remains pending. Re-enable once while the receiver is still unavailable; allow the remaining retries to run until this delivery is `failed`. Backoff is real; this can take a few minutes. Do not change database timestamps or attempt counts to accelerate the walkthrough.

Restart the receiver with the current signing secret, then select this event's failed delivery and replay it:

```powershell
$failedJobs = Invoke-RestMethod "$base/deliveries?endpoint_id=$endpointId&status=failed" -Headers $headers
# Select the delivery for your fictional-review-failure event.
$failed = $failedJobs | Where-Object event_id -EQ $failureEventId
Invoke-RestMethod "$base/deliveries/$($failed.id)/replay" -Method Post -Headers $headers
Invoke-RestMethod "$base/attempts?event_id=$($failed.event_id)" -Headers $headers
```

When replay succeeds, the event and delivery IDs stay the same, `attempt_count` is 9, `cycle_attempts` is 1, and all nine attempts remain. Replay does not re-enable a paused endpoint; do that separately if necessary. At-least-once delivery still requires durable receiver deduplication.

Local execution evidence and platform limits are recorded in [verification](verification.md). A sleeping free hosted service also stops its worker; no hosted demo exists yet. [Deployment](deployment.md) describes that limitation.
