<?php
// Read-only smoke test inside the Calendar container. Uses a synthetic junta.
$organization = '99999999-9999-4999-8999-999999999999';
$context = ['organization_id' => $organization, 'user_id' => '88888888-8888-4888-8888-888888888888', 'role' => 'viewer'];
$key = getenv('INTERNAL_KEY');
if (!is_string($key) || strlen($key) < 32) throw new RuntimeException('Missing internal configuration');
$call = function (string $method, string $path, array $data = []) use ($context, $key): array {
    $uri = '/internal/v1/'.$path;
    $body = json_encode($data, JSON_THROW_ON_ERROR);
    $claims = ['iss' => 'gateway', 'aud' => 'calendar', 'iat' => time(), 'exp' => time() + 30,
        'nonce' => bin2hex(random_bytes(16)), 'method' => $method, 'path' => $uri,
        'hash' => hash('sha256', $body), 'context' => $context];
    $encoded = base64_encode(json_encode($claims, JSON_THROW_ON_ERROR));
    $options = ['http' => ['method' => $method, 'timeout' => 10, 'ignore_errors' => true,
        'header' => "Content-Type: application/json\r\nAccept: application/json\r\nX-SRD-Context: ".$encoded.'.'.hash_hmac('sha256', $encoded, $key),
        'content' => $body]];
    $response = file_get_contents('http://127.0.0.1:8000'.$uri, false, stream_context_create($options));
    if ($response === false || !preg_match('/^HTTP\/\S+ (\d+)/', $http_response_header[0] ?? '', $match)) throw new RuntimeException('Calendar HTTP unavailable');
    return [(int)$match[1], json_decode($response, true, 512, JSON_THROW_ON_ERROR)];
};
[$status, $settings] = $call('GET', 'settings');
if ($status !== 200 || !array_key_exists('editor_roles', $settings['data'] ?? [])) throw new RuntimeException('Settings failed');
[$status, $events] = $call('GET', 'events', ['from' => '2026-09-22', 'to' => '2026-09-22']);
if ($status !== 200 || ($events['data']['timezone'] ?? '') !== 'America/Bogota' || !is_array($events['data']['items'] ?? null)) throw new RuntimeException('Event query failed');
[$status] = $call('POST', 'events', ['type' => 'meeting', 'title' => 'Should not be created', 'starts_at' => '2026-09-24T09:00:00-05:00', 'ends_at' => '2026-09-24T10:00:00-05:00']);
if ($status !== 403) throw new RuntimeException('Viewer write should be forbidden');
echo "PASS calendar settings, list and viewer write denial via signed HTTP/MySQL\n";
