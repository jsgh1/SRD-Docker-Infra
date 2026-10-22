<?php
// Read-only smoke test. Run inside the Records container via stdin.
$person = '99999999-9999-4999-8999-999999999999';
$context = ['organization_id' => '88888888-8888-4888-8888-888888888888', 'user_id' => $person, 'role' => 'admin'];
$cases = [
    ['POST', "persons/$person/photo-access", 'files', ['action' => 'persons.read'], 404],
    ['POST', "persons/$person/photo-access", 'gateway', ['action' => 'persons.read'], 403],
    ['GET', "persons/$person", 'files', [], 401],
];
foreach ($cases as [$method, $path, $issuer, $data, $expected]) {
    $uri = '/internal/v1/'.$path;
    $body = json_encode($data);
    $claims = ['iss' => $issuer, 'aud' => 'records', 'iat' => time(), 'exp' => time() + 30,
        'nonce' => bin2hex(random_bytes(16)), 'method' => $method, 'path' => $uri,
        'hash' => hash('sha256', $body), 'context' => $context];
    $encoded = base64_encode(json_encode($claims));
    $key = getenv('INTERNAL_KEY');
    if (!is_string($key) || strlen($key) < 32) throw new RuntimeException('Missing internal configuration');
    $options = ['http' => ['method' => $method, 'timeout' => 10, 'ignore_errors' => true,
        'header' => "Content-Type: application/json\r\nAccept: application/json\r\nX-SRD-Context: ".$encoded.'.'.hash_hmac('sha256', $encoded, $key),
        'content' => $body]];
    $result = file_get_contents('http://127.0.0.1:8000'.$uri, false, stream_context_create($options));
    if ($result === false || !preg_match('/^HTTP\/\S+ (\d+)/', $http_response_header[0] ?? '', $match)
        || (int)$match[1] !== $expected) throw new RuntimeException('Unexpected authorization response');
    echo "PASS $issuer $method: $expected\n";
}
