<?php
// Synthetic MySQL/HTTP smoke test. Stop calendar-scheduler during this test.
require '/app/services/calendar/vendor/autoload.php';
$app = require '/app/services/calendar/bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();
$organization = (string) Illuminate\Support\Str::uuid();
$context = ['organization_id' => $organization, 'user_id' => (string) Illuminate\Support\Str::uuid(), 'role' => 'admin'];
$key = getenv('INTERNAL_KEY');
if (!is_string($key) || strlen($key) < 32) throw new RuntimeException('Missing internal key');
$call = function (string $method, string $path, array $data = []) use ($context, $key): array {
    $uri = '/internal/v1/'.$path;
    $body = json_encode($data, JSON_THROW_ON_ERROR);
    $claims = ['iss' => 'gateway', 'aud' => 'calendar', 'iat' => time(), 'exp' => time() + 30,
        'nonce' => (string) Illuminate\Support\Str::uuid(), 'method' => $method,
        'path' => $uri, 'hash' => hash('sha256', $body), 'context' => $context];
    $encoded = base64_encode(json_encode($claims, JSON_THROW_ON_ERROR));
    $options = ['http' => ['method' => $method, 'timeout' => 10, 'ignore_errors' => true,
        'header' => "Content-Type: application/json\r\nAccept: application/json\r\nX-SRD-Context: ".$encoded.'.'.hash_hmac('sha256', $encoded, $key),
        'content' => $body]];
    $response = file_get_contents('http://127.0.0.1:8000'.$uri, false, stream_context_create($options));
    if ($response === false || !preg_match('/^HTTP\/\S+ (\d+)/', $http_response_header[0] ?? '', $match)) throw new RuntimeException('Calendar HTTP unavailable');
    return [(int) $match[1], json_decode($response, true, 512, JSON_THROW_ON_ERROR)];
};
try {
    $event = ['type' => 'meeting', 'title' => 'Ensayo sintético', 'starts_at' => '2026-09-24T09:00:00-05:00', 'ends_at' => '2026-09-24T10:00:00-05:00'];
    [$status, $created] = $call('POST', 'events', $event);
    if ($status !== 200 || ($created['data']['version'] ?? null) !== 1 || !str_ends_with($created['data']['starts_at'] ?? '', '+00:00')) throw new RuntimeException('Create failed');
    $id = $created['data']['id'];
    [$status, $listed] = $call('GET', 'events', ['from' => '2026-09-24', 'to' => '2026-09-24']);
    if ($status !== 200 || ($listed['data']['items'][0]['id'] ?? null) !== $id) throw new RuntimeException('List failed');
    [$status, $updated] = $call('PATCH', 'events/'.$id, $event + ['version' => 1]);
    if ($status !== 200 || ($updated['data']['version'] ?? null) !== 2) throw new RuntimeException('Update failed');
    [$status] = $call('PATCH', 'events/'.$id, $event + ['version' => 1]);
    if ($status !== 409) throw new RuntimeException('Stale version accepted');
    [$status, $cancelled] = $call('POST', 'events/'.$id.'/cancel', ['version' => 2]);
    if ($status !== 200 || ($cancelled['data']['state'] ?? null) !== 'cancelled') throw new RuntimeException('Cancel failed');
    if (Illuminate\Support\Facades\DB::table('outbox_events')->where('organization_id', $organization)->count() !== 3) throw new RuntimeException('Outbox incomplete');
    echo "PASS calendar create/list/update/conflict/cancel/outbox via signed HTTP/MySQL\n";
} finally {
    Illuminate\Support\Facades\DB::table('outbox_events')->where('organization_id', $organization)->delete();
    Illuminate\Support\Facades\DB::table('calendar_events')->where('organization_id', $organization)->delete();
    Illuminate\Support\Facades\DB::table('calendar_settings')->where('organization_id', $organization)->delete();
}
